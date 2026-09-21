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

  async generate({
    systemPrompt,
    userMessage,
    model,
    temperature,
    maxOutputTokens,
  }: ChatParams): Promise<ChatResult> {
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
        const response = await getClient(apiKeys[i]).models.generateContent({
          model,
          config: {
            // systemInstruction tách riêng khỏi contents — hàng rào chống prompt injection từ nội dung KB
            systemInstruction: systemPrompt,
            temperature,
            maxOutputTokens,
          },
          contents: userMessage,
        });

        const text = response.text;
        if (!text)
          throw new ProviderCallError("gemini", "Gemini trả về nội dung rỗng");

        if (i > 0)
          console.warn(`[Gemini] Đã trả lời bằng key dự phòng #${i + 1}`);
        return { text, usage: extractUsage(response.usageMetadata) };
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
