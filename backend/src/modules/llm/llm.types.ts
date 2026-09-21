/**
 * Kiểu dùng chung cho lớp adapter LLM (AI Chat box).
 *
 * Mục tiêu: ai.service.ts chỉ gọi qua interface này, không biết đang chạy provider nào —
 * đổi provider chỉ là đổi giá trị trong app_settings, không phải sửa pipeline RAG.
 */

/** Danh sách provider built-in được hỗ trợ cho phần sinh câu trả lời (chat). */
export const BUILTIN_CHAT_PROVIDER_IDS = ['custom', 'gemini'] as const;
export const CHAT_PROVIDER_IDS = BUILTIN_CHAT_PROVIDER_IDS;
export type BuiltinChatProviderId = (typeof BUILTIN_CHAT_PROVIDER_IDS)[number];
export type ChatProviderId = BuiltinChatProviderId | (string & {});

/**
 * Thứ tự thử fallback mặc định khi provider đang chọn lỗi/hết quota.
 * Provider Admin chọn luôn chạy TRƯỚC, các provider dưới đây chạy sau và bỏ qua cái đã thử.
 */
export const FALLBACK_ORDER: ChatProviderId[] = ['custom', 'gemini'];

export interface ChatParams {
  /** System prompt — tách riêng khỏi context KB để chống prompt injection. */
  systemPrompt: string;
  /** Nội dung user + context KB (đã bọc delimiter ở ai.service). */
  userMessage: string;
  /** Model id cụ thể của provider (vd 'gemini-3.6-flash', 'llama-3.3-70b-versatile'). */
  model: string;
  temperature: number;
  maxOutputTokens: number;
}

/**
 * Số token của MỘT lần gọi model, do chính nhà cung cấp đếm và trả về trong response —
 * không phải ước lượng phía client, nên khớp với số bị trừ quota/tính tiền.
 */
export interface ChatTokenUsage {
  /** Token đầu vào: system prompt + context KB + câu hỏi. */
  inputTokens: number;
  /** Token đầu ra: nội dung sinh ra, ĐÃ GỘP cả phần "thinking" của model nếu có. */
  outputTokens: number;
  /** Tổng do provider trả về. Không tự cộng input + output vì có thể còn loại token khác. */
  totalTokens: number;
}

export interface ChatResult {
  text: string;
  /**
   * undefined khi provider không trả về thông tin token (hoặc trả về sai định dạng).
   * Cố ý để optional: thiếu số liệu thống kê thì bỏ qua, không được làm hỏng câu trả lời.
   */
  usage?: ChatTokenUsage;
  /**
   * Model THỰC SỰ đã trả lời, khi provider tự đổi model bên trong (vd Gemini quá tải → chuyển sang
   * bản nhẹ). Không có thì hiểu là đúng model đã yêu cầu.
   */
  model?: string;
}

export interface ChatProvider {
  id: ChatProviderId;
  /** Tên hiển thị cho Admin UI. */
  label: string;
  /** Model mặc định khi Admin chưa chọn, hoặc khi provider này được dùng làm fallback. */
  defaultModel: string;
  /** Gợi ý model cho Admin UI — Admin vẫn được nhập model id tự do vì model free thay đổi liên tục. */
  suggestedModels: string[];
  /** Tên biến môi trường chứa API key của provider này (chỉ để hiển thị hướng dẫn, không trả giá trị). */
  apiKeyEnvName?: string;
  /** Đánh dấu là cổng custom từ DB */
  isCustom?: boolean;
  /** ID trong DB nếu là cổng custom */
  customGatewayId?: string;
  /** Có API key hay chưa — thiếu key thì provider bị bỏ qua hoàn toàn. */
  hasApiKey(): boolean;
  generate(params: ChatParams): Promise<ChatResult>;
  /**
   * Hỏi thẳng nhà cung cấp xem key hiện tại được dùng những model nào.
   *
   * Optional vì không phải provider nào cũng có endpoint này. `suggestedModels` là danh sách
   * CỨNG trong code nên sẽ lạc hậu khi nhà cung cấp thêm/bớt model — hàm này mới là nguồn thật.
   */
  listModels?(): Promise<string[]>;
}

/**
 * Lỗi khi provider từ chối phục vụ vì hết quota / bị rate limit (429, RESOURCE_EXHAUSTED).
 * Đây là loại lỗi CHÍNH đáng để chuyển sang provider khác.
 */
export class ProviderQuotaError extends Error {
  constructor(
    public providerId: ChatProviderId,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderQuotaError';
  }
}

/** Lỗi gọi provider vì lý do khác (cấu hình sai model, 401, 5xx, mất mạng...). */
export class ProviderCallError extends Error {
  constructor(
    public providerId: ChatProviderId,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderCallError';
  }
}

/**
 * Toàn bộ provider khả dụng đều đã thử và đều thất bại.
 * `code` được errorHandler trả về FE để Admin thấy cảnh báo trong console trình duyệt.
 */
export class AllProvidersExhaustedError extends Error {
  code = 'ALL_PROVIDERS_EXHAUSTED';
  aiName = 'AI Chat';

  constructor(
    /** Chi tiết từng provider đã thử và lý do thất bại — dùng để log ở BE. */
    public attempts: Array<{ providerId: ChatProviderId; reason: string }>,
  ) {
    super('Tất cả provider AI đều không phản hồi được (hết quota hoặc lỗi cấu hình)');
    this.name = 'AllProvidersExhaustedError';
  }
}
