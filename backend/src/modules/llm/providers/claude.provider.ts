import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../../config/env";
import {
  ChatParams,
  ChatProvider,
  ChatResult,
  ProviderCallError,
  ProviderQuotaError,
} from "../llm.types";

/**
 * Provider Anthropic Claude — gọi Messages API qua SDK chính thức `@anthropic-ai/sdk`.
 *
 * CHỈ chạy khi Admin chọn Claude làm nguồn chính ở trang Cấu hình AI: cố ý KHÔNG có mặt trong
 * FALLBACK_ORDER (llm.types.ts) vì Claude tính tiền theo token — để nó tự nhận việc mỗi khi Gemini
 * lỗi là phát sinh chi phí mà không ai quyết định. Khi Claude là nguồn chính thì Gemini vẫn làm dự
 * phòng như bình thường.
 */

/** Thời gian chờ mỗi lần gọi. SDK tự gọi lại khi gặp 429 / 5xx / quá tải (529) — giới hạn 1 lần. */
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 1;

/**
 * Sàn cho max_tokens. Model Claude đời mới (Sonnet 5, Opus 5…) bật "suy nghĩ" mặc định và token suy
 * nghĩ TÍNH VÀO max_tokens — giữ con số nhỏ của bên gọi (1024 ở bước viết lại câu hỏi) dễ làm câu
 * trả lời bị cắt cụt, đúng lỗi đã gặp với Gemini 3.x. Chỉ token thực sự sinh ra mới bị tính tiền nên
 * nâng trần không tốn thêm; độ dài câu trả lời vẫn do prompt quyết định.
 */
const MIN_MAX_TOKENS = 16_000;

function hasKey(): boolean {
  return !!env.ANTHROPIC_API_KEY?.trim();
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
  }
  return client;
}

/**
 * Mức suy nghĩ "low": hỏi đáp RAG và viết lại câu hỏi là việc ngắn, cần nhanh — mức cao chỉ làm chậm
 * và tốn thêm token. Haiku 4.5 và Sonnet 4.5 KHÔNG nhận tham số này (trả 400) nên bỏ qua với 2 dòng đó.
 */
function supportsEffort(model: string): boolean {
  return !/haiku-4-5|sonnet-4-5/.test(model);
}

async function generate({
  systemPrompt,
  userMessage,
  model,
  maxOutputTokens,
}: ChatParams): Promise<ChatResult> {
  if (!hasKey()) {
    throw new ProviderCallError("claude", "ANTHROPIC_API_KEY is not configured in .env");
  }

  try {
    // KHÔNG gửi temperature: Sonnet 5, Opus 4.7 trở lên trả lỗi 400 nếu có tham số lấy mẫu.
    const response = await getClient().messages.create({
      model,
      max_tokens: Math.max(maxOutputTokens, MIN_MAX_TOKENS),
      // system tách riêng khỏi messages — hàng rào chống prompt injection từ nội dung KB
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      ...(supportsEffort(model) && { output_config: { effort: "low" as const } }),
    });

    // Bộ lọc an toàn của Claude từ chối → báo lỗi để llm.service chuyển sang provider khác. Nội dung
    // KB về cá cược có thể bị chặn nhầm; câu hỏi khi đó vẫn được Gemini trả lời thay.
    if (response.stop_reason === "refusal") {
      throw new ProviderCallError("claude", "Claude declined to answer this question (safety filter)");
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new ProviderCallError("claude", "Claude returned an empty response");

    if (response.stop_reason === "max_tokens") {
      console.warn(`[Claude] ${model} chạm giới hạn max_tokens — câu trả lời có thể bị cắt`);
    }

    // output_tokens của Claude ĐÃ gồm token suy nghĩ (tính tiền như output) — không phải cộng thêm
    // như với Gemini.
    const { input_tokens, output_tokens } = response.usage;
    return {
      text,
      usage: {
        inputTokens: input_tokens,
        outputTokens: output_tokens,
        totalTokens: input_tokens + output_tokens,
      },
    };
  } catch (err) {
    if (err instanceof ProviderCallError) throw err;
    if (err instanceof Anthropic.RateLimitError) {
      throw new ProviderQuotaError("claude", `Claude quota/rate limit exceeded (429): ${err.message}`);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      throw new ProviderCallError("claude", "ANTHROPIC_API_KEY is invalid or has been revoked");
    }
    if (err instanceof Anthropic.APIError) {
      throw new ProviderCallError("claude", `HTTP ${err.status ?? "?"}: ${err.message}`);
    }
    throw new ProviderCallError("claude", err instanceof Error ? err.message : String(err));
  }
}

/** Danh sách model key hiện tại được dùng — cho nút "Tải danh sách model" ở trang Cấu hình AI. */
async function listModels(): Promise<string[]> {
  if (!hasKey()) {
    throw new ProviderCallError("claude", "ANTHROPIC_API_KEY is not configured in .env");
  }
  try {
    const ids: string[] = [];
    for await (const model of getClient().models.list()) ids.push(model.id);
    return ids;
  } catch (err) {
    throw new ProviderCallError("claude", err instanceof Error ? err.message : String(err));
  }
}

export const claudeProvider: ChatProvider = {
  id: "claude",
  label: "Anthropic Claude",
  defaultModel: env.CLAUDE_MODEL,
  suggestedModels: [
    ...new Set([env.CLAUDE_MODEL, "claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"]),
  ],
  apiKeyEnvName: "ANTHROPIC_API_KEY",
  hasApiKey: hasKey,
  generate,
  listModels,
};
