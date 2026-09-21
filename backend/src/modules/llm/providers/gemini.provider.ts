import {
  GoogleGenAI,
  GenerateContentResponseUsageMetadata,
} from "@google/genai";
import { env } from "../../../config/env";
import {
  ChatParams,
  ChatProvider,
  ChatResult,
  ChatTokenUsage,
  ProviderCallError,
  ProviderQuotaError,
} from "../llm.types";

/**
 * Provider Google Gemini — provider mặc định của hệ thống.
 *
 * Hỗ trợ NHIỀU API key: khi key đang dùng trả 429/hết quota thì tự chuyển sang key tiếp theo.
 * Chỉ khi tất cả key đều hết quota mới báo lên llm.service để chuyển sang provider khác.
 *
 * Lưu ý: đây CHỈ là provider cho phần chat. Phần embedding (indexing.service/search.service)
 * vẫn gọi thẳng Gemini `gemini-embedding-001` @768 chiều bằng key chính, cố ý không đi qua
 * adapter này: đổi model embedding sẽ làm vector cũ trong content_chunks không còn so sánh
 * được, làm hỏng search một cách âm thầm.
 */

/** Danh sách key theo thứ tự ưu tiên — key sau chỉ được dùng khi key trước hết quota. */
function getApiKeys(): string[] {
  return [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2]
    .map((k) => k?.trim() ?? "")
    .filter((k) => k !== "");
}

/** Cache client theo key để không phải khởi tạo lại SDK ở mỗi request. */
const clientCache = new Map<string, GoogleGenAI>();

function getClient(apiKey: string): GoogleGenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    clientCache.set(apiKey, client);
  }
  return client;
}

/**
 * Lấy số token thật từ usageMetadata Gemini trả về kèm mỗi response (không tốn thêm request).
 *
 * QUAN TRỌNG: outputTokens phải cộng cả `thoughtsTokenCount` — token "suy nghĩ" của các model
 * thinking (dòng gemini-3.x) bị tính như output khi trừ quota nhưng KHÔNG nằm trong
 * candidatesTokenCount. Chỉ cộng prompt + candidates là đếm thiếu.
 *
 * Trả về undefined khi không có số liệu — thống kê thiếu thì bỏ qua, không được làm hỏng câu trả lời.
 */
function extractUsage(
  meta: GenerateContentResponseUsageMetadata | undefined,
): ChatTokenUsage | undefined {
  if (!meta) return undefined;

  const inputTokens = meta.promptTokenCount ?? 0;
  const outputTokens =
    (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
  // Ưu tiên totalTokenCount của Google thay vì tự cộng: có thể còn loại token khác (tool use...)
  const totalTokens = meta.totalTokenCount ?? inputTokens + outputTokens;

  if (totalTokens <= 0) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function isQuotaError(message: string): boolean {
  return /429|RESOURCE_EXHAUSTED|quota/i.test(message);
}

/**
 * Lỗi QUÁ TẢI TẠM THỜI phía Google (503 UNAVAILABLE, "high demand") — khác hẳn hết quota: key vẫn
 * còn hạn mức, chỉ là model đang bị gọi quá đông. Đổi key vô ích vì quá tải tính theo MODEL chứ
 * không theo key; cách đúng là chờ chút rồi gọi lại, vẫn quá tải thì chuyển sang bản nhẹ hơn.
 *
 * Đo thực tế 21/09/2026: gemini-3.6-flash trả 503 xen kẽ khoảng 1/3 số lần gọi, trong khi cổng dự
 * phòng `custom` đang hỏng key — thiếu bước này là người dùng nhận thẳng "Lỗi máy chủ nội bộ".
 */
function isOverloadError(message: string): boolean {
  return /\b503\b|UNAVAILABLE|overloaded|high demand/i.test(message);
}

/** Thời gian chờ trước mỗi lần gọi lại model chính khi quá tải — tổng cộng thêm tối đa ~4,5 giây. */
const OVERLOAD_RETRY_DELAYS_MS = [1500, 3000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Quá tải không phải lúc nào cũng trả 503 — nhiều khi model chỉ TREO không trả lời (đo 21/09/2026:
 * gemini-3.6-flash treo quá 60s trong khi bản nhẹ trả lời trong ~3s). Không đặt giới hạn thì người
 * dùng ngồi nhìn "Đang soạn câu trả lời..." mãi mãi. Model chính quá 25s thì bỏ, sang thẳng bản nhẹ
 * (không gọi lại model đang treo — chờ thêm vô ích). Câu trả lời bình thường chỉ mất vài giây.
 */
const PRIMARY_TIMEOUT_MS = 25_000;
/** Bản nhẹ thường trả lời trong 1–3s; vẫn phải có giới hạn để không bao giờ treo vô hạn. */
const FALLBACK_TIMEOUT_MS = 30_000;

/**
 * Gọi Gemini bằng MỘT key: model chính (gọi lại khi báo 503; treo quá PRIMARY_TIMEOUT_MS thì bỏ
 * luôn) → vẫn quá tải thì bản nhẹ dự phòng
 * `GEMINI_FALLBACK_MODEL`. Trả kèm tên model THỰC SỰ đã trả lời để thống kê token ghi đúng.
 *
 * Lỗi hết quota được ném nguyên trạng để vòng lặp key bên ngoài chuyển sang key kế tiếp; quá tải
 * tới cả bản nhẹ thì ném ProviderCallError để llm.service chuyển sang provider khác.
 */
async function generateWithOverloadFallback(client: GoogleGenAI, params: ChatParams) {
  const models = [...new Set([params.model, env.GEMINI_FALLBACK_MODEL])];

  for (let m = 0; m < models.length; m++) {
    const retryDelays = m === 0 ? OVERLOAD_RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.timeout(m === 0 ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS);
      try {
        const response = await client.models.generateContent({
          model: models[m] as string,
          config: {
            // systemInstruction tách riêng khỏi contents — hàng rào chống prompt injection từ nội dung KB
            systemInstruction: params.systemPrompt,
            temperature: params.temperature,
            maxOutputTokens: params.maxOutputTokens,
            abortSignal: signal,
          },
          contents: params.userMessage,
        });
        return { response, model: models[m] as string };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Treo quá giới hạn thời gian → coi như quá tải nhưng KHÔNG gọi lại model đó nữa
        if (signal.aborted) {
          const seconds = (m === 0 ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS) / 1000;
          if (m === models.length - 1) {
            throw new ProviderCallError("gemini", `${models[m]} không phản hồi sau ${seconds}s`);
          }
          console.warn(`[Gemini] ${models[m]} không phản hồi sau ${seconds}s — chuyển sang bản nhẹ ${models[m + 1]}`);
          break;
        }

        if (!isOverloadError(message)) throw err;

        if (attempt < retryDelays.length) {
          const delay = retryDelays[attempt] as number;
          console.warn(`[Gemini] ${models[m]} quá tải — gọi lại sau ${delay / 1000}s`);
          await sleep(delay);
          continue;
        }
        if (m === models.length - 1) throw new ProviderCallError("gemini", message);
        console.warn(`[Gemini] ${models[m]} vẫn quá tải — chuyển sang bản nhẹ ${models[m + 1]}`);
        break;
      }
    }
  }

  // Không tới được đây: vòng lặp trên luôn return hoặc throw
  throw new ProviderCallError("gemini", "Không gọi được model Gemini nào");
}

export const geminiProvider: ChatProvider = {
  id: "gemini",
  label: "Google Gemini",
  defaultModel: env.GEMINI_MODEL,
  suggestedModels: [env.GEMINI_MODEL, "gemini-flash-latest"],
  apiKeyEnvName: "GEMINI_API_KEY",

  hasApiKey() {
    return getApiKeys().length > 0;
  },

  /**
   * Liệt kê model của Gemini bằng SDK (không có endpoint /v1/models kiểu OpenAI).
   *
   * Chỉ lấy model có 'generateContent' trong supportedActions — danh sách thô còn gồm cả model
   * embedding và model chỉ dùng để đếm token, đưa vào ô Model chat là chọn nhầm.
   * Tên trả về dạng 'models/gemini-3.6-flash' nên phải cắt tiền tố.
   */
  async listModels() {
    const apiKeys = getApiKeys();
    if (apiKeys.length === 0) {
      throw new ProviderCallError('gemini', 'Chưa cấu hình GEMINI_API_KEY trong .env');
    }

    try {
      const pager = await getClient(apiKeys[0]).models.list();
      const ids: string[] = [];

      for await (const model of pager) {
        if (!model.name) continue;
        if (model.supportedActions && !model.supportedActions.includes('generateContent')) continue;
        ids.push(model.name.replace(/^models\//, ''));
      }

      return ids;
    } catch (err) {
      throw new ProviderCallError('gemini', err instanceof Error ? err.message : String(err));
    }
  },

  async generate(params: ChatParams): Promise<ChatResult> {
    const apiKeys = getApiKeys();
    if (apiKeys.length === 0) {
      throw new ProviderCallError(
        "gemini",
        "Chưa cấu hình GEMINI_API_KEY trong .env",
      );
    }

    let lastQuotaMessage = "";

    for (let i = 0; i < apiKeys.length; i++) {
      try {
        const { response, model } = await generateWithOverloadFallback(getClient(apiKeys[i]), params);

        const text = response.text;
        if (!text)
          throw new ProviderCallError("gemini", "Gemini trả về nội dung rỗng");

        if (i > 0)
          console.warn(`[Gemini] Đã trả lời bằng key dự phòng #${i + 1}`);
        return { text, usage: extractUsage(response.usageMetadata), model };
      } catch (err) {
        if (err instanceof ProviderCallError) throw err;

        const message = err instanceof Error ? err.message : String(err);

        // Hết quota → thử key kế tiếp (nếu còn)
        if (isQuotaError(message)) {
          lastQuotaMessage = message;
          console.warn(
            `[Gemini] Key #${i + 1} hết quota${i + 1 < apiKeys.length ? " — thử key tiếp theo" : ""}`,
          );
          continue;
        }

        // Lỗi khác (sai model, mất mạng...) thì đổi key cũng vô ích — báo lỗi ngay
        throw new ProviderCallError("gemini", message);
      }
    }

    // Tất cả key Gemini đều hết quota → để llm.service chuyển sang provider khác
    throw new ProviderQuotaError(
      "gemini",
      `Toàn bộ ${apiKeys.length} key Gemini đều hết quota. ${lastQuotaMessage}`,
    );
  },
};
