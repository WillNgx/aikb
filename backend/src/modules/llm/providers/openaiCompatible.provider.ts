import { env } from '../../../config/env';
import {
  ChatParams,
  ChatProvider,
  ChatProviderId,
  ChatResult,
  ChatTokenUsage,
  ProviderCallError,
  ProviderQuotaError,
} from '../llm.types';

/**
 * Adapter dùng chung cho mọi provider theo chuẩn OpenAI Chat Completions — hiện là cổng `custom`
 * lấy cấu hình từ `.env`, cộng các cổng Admin tự thêm trong bảng `custom_ai_gateways`. Chúng dùng
 * chung endpoint `/chat/completions` và cùng format request/response nên chỉ khác baseUrl + API
 * key + vài header phụ, không cần viết adapter riêng cho từng cổng.
 *
 * Gọi bằng fetch có sẵn của Node 18+ thay vì cài thêm SDK, để không thêm dependency mới.
 */

/**
 * Hết thời gian chờ mặc định cho 1 request — tránh treo cả AI Chat khi provider phản hồi chậm.
 * Từng provider có thể khai `requestTimeoutMs` riêng để đè giá trị này.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

/**
 * Riêng cổng `custom` chờ lâu hơn hẳn. Đo thực tế trên cổng đang dùng: độ trễ tỉ lệ với ĐỘ DÀI
 * CÂU TRẢ LỜI chứ gần như không phụ thuộc độ dài context (`GET /models` 1.0s, trả lời ngắn 5.2s,
 * context dài + trả lời ngắn 1.7s, nhưng trả lời dài với max_tokens 2048 mất 26s). Câu trả lời
 * RAG đầy đủ vì thế hay vượt mốc 45s và bị huỷ oan, buộc hệ thống fallback sang provider khác
 * dù cổng vẫn đang chạy bình thường.
 *
 * KHÔNG nâng mốc mặc định theo: mốc đó còn áp cho những cổng Admin tự thêm, để chúng chờ tới
 * 120s nghĩa là khi thật sự treo thì người dùng phải ngồi đợi gấp đôi rồi mới được chuyển sang
 * provider dự phòng.
 */
const CUSTOM_REQUEST_TIMEOUT_MS = 120_000;

export interface OpenAICompatibleConfig {
  id: ChatProviderId;
  label: string;
  baseUrl: string;
  apiKeyEnvName?: string;
  getApiKey: () => string | undefined;
  defaultModel: string;
  suggestedModels: string[];
  /** Header bổ sung riêng của cổng (có cổng yêu cầu thêm HTTP-Referer/X-Title). */
  extraHeaders?: Record<string, string>;
  /** Thời gian chờ riêng của provider này. Không khai thì dùng DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  isCustom?: boolean;
  customGatewayId?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  /** Chuẩn OpenAI: số token do server đếm, mọi cổng tương thích đều trả về. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

/** Đổi khối `usage` chuẩn OpenAI sang kiểu dùng chung. undefined khi provider không trả về. */
function extractUsage(usage: ChatCompletionResponse['usage']): ChatTokenUsage | undefined {
  if (!usage) return undefined;

  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;

  if (totalTokens <= 0) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): ChatProvider {
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    id: config.id,
    label: config.label,
    defaultModel: config.defaultModel,
    suggestedModels: config.suggestedModels,
    apiKeyEnvName: config.apiKeyEnvName,
    isCustom: config.isCustom,
    customGatewayId: config.customGatewayId,

    hasApiKey() {
      return !!config.getApiKey();
    },

    /** GET <baseUrl>/models — chuẩn OpenAI, dùng chung cho mọi cổng tương thích. */
    async listModels() {
      const apiKey = config.getApiKey();
      if (!apiKey) {
        const keyMsg = config.apiKeyEnvName
          ? `${config.apiKeyEnvName} is not configured in .env`
          : 'API Key is not configured';
        throw new ProviderCallError(config.id, keyMsg);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
        const response = await fetch(`${cleanBaseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}`, ...config.extraHeaders },
          signal: controller.signal,
        });

        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          throw new ProviderCallError(config.id, `HTTP ${response.status} ${bodyText.slice(0, 300)}`);
        }

        const data = (await response.json()) as { data?: Array<{ id?: string }> };
        // Cổng trả model theo đúng quyền của key, nên đây là danh sách THẬT dùng được
        return (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
      } catch (err) {
        if (err instanceof ProviderCallError) throw err;

        const message =
          err instanceof Error && err.name === 'AbortError'
            ? `Timed out after ${requestTimeoutMs / 1000}s`
            : err instanceof Error
              ? err.message
              : String(err);
        throw new ProviderCallError(config.id, message);
      } finally {
        clearTimeout(timeout);
      }
    },

    async generate({
      systemPrompt,
      userMessage,
      model,
      temperature,
      maxOutputTokens,
    }: ChatParams): Promise<ChatResult> {
      const apiKey = config.getApiKey();
      if (!apiKey) {
        const keyMsg = config.apiKeyEnvName
          ? `${config.apiKeyEnvName} is not configured in .env`
          : 'API Key is not configured';
        throw new ProviderCallError(config.id, keyMsg);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
        const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...config.extraHeaders,
          },
          body: JSON.stringify({
            model,
            // System prompt là message riêng, giữ đúng ranh giới với context KB như bên Gemini
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
            temperature,
            max_tokens: maxOutputTokens,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          const detail = `HTTP ${response.status} ${bodyText.slice(0, 300)}`;

          // 429 = hết quota/rate limit → đáng để chuyển sang provider khác
          if (response.status === 429) throw new ProviderQuotaError(config.id, detail);
          throw new ProviderCallError(config.id, detail);
        }

        const data = (await response.json()) as ChatCompletionResponse;
        const text = data.choices?.[0]?.message?.content;

        if (!text) {
          throw new ProviderCallError(
            config.id,
            data.error?.message ?? 'Provider returned an empty response',
          );
        }

        return { text, usage: extractUsage(data.usage) };
      } catch (err) {
        if (err instanceof ProviderQuotaError || err instanceof ProviderCallError) throw err;

        const message =
          err instanceof Error && err.name === 'AbortError'
            ? `Timed out after ${requestTimeoutMs / 1000}s`
            : err instanceof Error
              ? err.message
              : String(err);
        throw new ProviderCallError(config.id, message);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createCustomGatewayProvider(gateway: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  suggestedModels?: string[] | null;
}): ChatProvider {
  return createOpenAICompatibleProvider({
    id: `custom_${gateway.id}`,
    label: `${gateway.name} (Custom)`,
    baseUrl: gateway.baseUrl,
    getApiKey: () => gateway.apiKey,
    defaultModel: gateway.defaultModel,
    suggestedModels:
      gateway.suggestedModels && gateway.suggestedModels.length > 0
        ? gateway.suggestedModels
        : [gateway.defaultModel],
    requestTimeoutMs: CUSTOM_REQUEST_TIMEOUT_MS,
    isCustom: true,
    customGatewayId: gateway.id,
  });
}

export const customProvider = createOpenAICompatibleProvider({
  id: 'custom',
  label: 'Relay gateway (self-configured)',
  // baseUrl và model mặc định lấy từ .env (CUSTOM_BASE_URL / CUSTOM_MODEL) để đổi nhà cung cấp
  // không phải sửa code — chỉ sửa .env rồi khởi động lại backend.
  baseUrl: env.CUSTOM_BASE_URL,
  apiKeyEnvName: 'CUSTOM_API_KEY',
  getApiKey: () => env.CUSTOM_API_KEY,
  defaultModel: env.CUSTOM_MODEL,
  // Danh sách model do bên cấp key quyết định và đổi bất cứ lúc nào, nên đây chỉ là ảnh chụp lúc
  // tích hợp; model trong env luôn đứng đầu để Admin thấy ngay lựa chọn đang cấu hình.
  // Kiểm tra lại bằng: curl.exe -s <CUSTOM_BASE_URL>/models -H "Authorization: Bearer <key>"
  suggestedModels: [
    ...new Set([env.CUSTOM_MODEL, 'deepseek.v3.2', 'glm-5', 'kimi-k2.5', 'mistral-large-3-675b-instruct']),
  ],
  requestTimeoutMs: CUSTOM_REQUEST_TIMEOUT_MS,
});
