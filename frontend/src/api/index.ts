import { useQuery } from '@tanstack/react-query';
import i18n from '../lib/i18n';
import api from './client';
import { TOKEN_HINT_KEY, getAccessToken, signOut, supabase } from '../lib/supabase';
import { getActiveKb } from '../lib/kb';
import { appendChatHistory, readChatHistory, type ChatHistoryItem } from '../lib/chatHistory';

/** Ba vai trò, xếp theo phạm vi từ rộng tới hẹp — xem backend `db/enums.ts`. */
export type UserRole = 'super_admin' | 'admin' | 'user';

export interface AuthUserInfo {
  id: string;
  email: string;
  role: UserRole;
  /**
   * KB mà tài khoản này thuộc về: KB mở sẵn khi đăng nhập, và với vai trò `admin` (Quản trị KB)
   * thì cũng là KB DUY NHẤT họ được sửa. Đọc thì mọi vai trò đều xem được mọi KB.
   */
  defaultKb: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  getMe: (): Promise<AuthUserInfo> => api.get('/auth/me').then((r) => r.data),
};

export function useAuthUser() {
  const token = localStorage.getItem(TOKEN_HINT_KEY);
  const { data: user, isLoading } = useQuery<AuthUserInfo>({
    queryKey: ['me'],
    queryFn: authApi.getMe,
    enabled: !!token,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  return {
    user,
    /** Quản trị ở mức nào cũng tính — dùng để hiện/ẩn khu vực Quản trị nói chung. */
    isAdmin: user?.role === 'super_admin' || user?.role === 'admin',
    /** Riêng Quản trị hệ thống: quản lý tài khoản, tạo KB, cấu hình dùng chung. */
    isSuperAdmin: user?.role === 'super_admin',
    isLoading,
  };
}

// ─── AI Chat ─────────────────────────────────────────────────────────────────

export interface AiCitation {
  chunkId: string;
  contentId: string;
  contentTitle: string;
  sectionTitle: string | null;
  headingIndex: number | null;
  excerpt: string;
}

export interface AiSuggestion {
  contentId: string;
  contentTitle: string;
  sectionTitle: string | null;
  excerpt: string;
}

export interface AiClarificationOption {
  label: string;
  provider: string;
  query: string;
}

export interface AiChatResponse {
  answer: string;
  citations: AiCitation[];
  hasAnswer: boolean;
  suggestions?: AiSuggestion[];
  needsClarification?: boolean;
  clarificationQuestion?: string;
  clarificationOptions?: AiClarificationOption[];
  note?: string;
}

/**
 * Các bước của pipeline RAG do backend đẩy về qua SSE.
 *
 * Kiểu này được khai báo LẠI ở đây thay vì dùng chung với backend: FE và BE là hai project độc
 * lập, không import chéo nhau (giống cách `TiptapDoc` đang tồn tại hai bản). Đổi hình dạng event
 * thì phải sửa cả `ChatProgress` trong `backend/src/modules/ai/ai.service.ts` lẫn chỗ này.
 */
export type ChatProgress =
  | { step: 'understanding' }
  | { step: 'searching' }
  | { step: 'expanding' }
  | { step: 'generating'; chunkCount: number };

/**
 * Lỗi của luồng SSE, cố ý giả lập đúng hình dạng lỗi của axios (`err.response.status` /
 * `err.response.data`) để hai màn chat dùng lại nguyên khối xử lý lỗi sẵn có, không phải viết
 * thêm một nhánh riêng cho stream.
 */
class ChatStreamError extends Error {
  response: { status: number; data?: unknown };

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = 'ChatStreamError';
    this.response = { status, data };
  }
}

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

function postChatStream(
  question: string,
  token: string | null,
  history: ChatHistoryItem[],
): Promise<Response> {
  const kb = getActiveKb();
  return fetch(`${API_BASE_URL}/ai/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-KB': kb,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // Lịch sử hội thoại đi kèm request thay vì để backend tra DB theo user_id — xem
    // lib/chatHistory.ts để biết vì sao (nhiều người dùng chung một tài khoản).
    body: JSON.stringify({ question, history }),
  });
}

/**
 * Hỏi AI qua SSE, gọi `onProgress` mỗi khi backend báo sang bước mới.
 *
 * Dùng `fetch` chứ không dùng instance axios: axios trên trình duyệt không đọc được response
 * dạng stream. Hệ quả là request này KHÔNG đi qua interceptor trong `api/client.ts`, nên phần
 * gắn token và xử lý 401 phải làm lại thủ công ngay tại đây.
 *
 * Chỉ quay về endpoint `/ai/chat` thường trong hai trường hợp mà pipeline CHẮC CHẮN chưa chạy
 * (không mở nổi kết nối, hoặc backend chưa có route stream). Mọi lỗi khác đều ném lên: gọi lại
 * đồng nghĩa chạy pipeline lần hai và tốn thêm một lượt gọi model của quota.
 */
async function chatStream(
  question: string,
  onProgress: (progress: ChatProgress) => void,
): Promise<AiChatResponse> {
  // Đọc lịch sử MỘT LẦN cho cả lượt hỏi này, rồi mới ghi câu hỏi hiện tại vào — ghi trước sẽ
  // khiến chính câu đang hỏi lẫn vào 'lịch sử' của nó. Mọi đường quay lui bên dưới đều dùng lại
  // đúng mảng này để không ghi trùng.
  const kbHienTai = getActiveKb();
  const history = readChatHistory(kbHienTai);
  appendChatHistory(kbHienTai, question);

  let res: Response;
  try {
    res = await postChatStream(question, await getAccessToken(), history);
  } catch {
    return aiApi.chat(question, history);
  }

  // 401 → làm mới phiên ĐÚNG MỘT LẦN rồi thử lại, hệt như interceptor axios đang làm.
  if (res.status === 401) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session?.access_token) {
      res = await postChatStream(question, data.session.access_token, history);
    }

    if (res.status === 401) {
      await signOut();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      throw new ChatStreamError(i18n.t('api.sessionExpired'), 401);
    }
  }

  if (res.status === 404) return aiApi.chat(question, history);

  if (!res.ok) {
    const data = await res.json().catch(() => undefined);
    throw new ChatStreamError(i18n.t('api.aiChatFailed'), res.status, data);
  }

  // Trình duyệt không cho đọc body dạng stream — hiếm, nhưng nếu xảy ra thì không còn cách nào
  // lấy được kết quả của lượt vừa chạy, đành hỏi lại bằng endpoint thường.
  if (!res.body) return aiApi.chat(question, history);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AiChatResponse | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Mỗi event SSE kết thúc bằng một dòng trống. `data` luôn nằm gọn trên một dòng vì
    // JSON.stringify đã escape hết ký tự xuống dòng bên trong.
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');

      const eventName = /^event: (.*)$/m.exec(block)?.[1];
      const rawData = /^data: (.*)$/m.exec(block)?.[1];
      if (!eventName || rawData === undefined) continue;

      let payload: unknown;
      try {
        payload = JSON.parse(rawData);
      } catch {
        continue;
      }

      if (eventName === 'progress') {
        onProgress(payload as ChatProgress);
      } else if (eventName === 'done') {
        result = payload as AiChatResponse;
      } else if (eventName === 'error') {
        const data = payload as { error?: string };
        throw new ChatStreamError(data?.error ?? i18n.t('api.serverError'), 500, payload);
      }
    }
  }

  if (!result) {
    throw new ChatStreamError(i18n.t('api.streamInterrupted'), 500);
  }

  return result;
}

export const aiApi = {
  // Timeout riêng dài hơn mặc định (30s) — pipeline RAG + gọi Gemini Flash generateContent thực
  // tế có thể mất tới 100s (đã đo trực tiếp: lần gọi Gemini đầu tiên sau khi server nguội mất
  // ~50s, các lần sau chỉ ~4s), dễ bị axios default timeout hủy giữa chừng dù server vẫn đang
  // xử lý bình thường và sẽ trả lời được.
  chat: (question: string, history?: ChatHistoryItem[]) => {
    // Gọi trực tiếp (không qua chatStream) thì tự đọc lịch sử và ghi nhớ câu hỏi.
    let lichSu = history;
    if (!lichSu) {
      const kb = getActiveKb();
      lichSu = readChatHistory(kb);
      appendChatHistory(kb, question);
    }
    return api
      .post('/ai/chat', { question, history: lichSu }, { timeout: 120000 })
      .then((r) => r.data);
  },

  /** Như `chat()` nhưng báo tiến trình từng bước — xem `chatStream` ở trên. */
  chatStream,
};

// ─── Admin ────────────────────────────────────────────────────────────────────

/** Trạng thái 1 provider AI — hasApiKey chỉ báo có key hay chưa, không bao giờ chứa giá trị key. */
export interface AIProviderInfo {
  id: string;
  label: string;
  defaultModel: string;
  suggestedModels: string[];
  apiKeyEnvName?: string;
  isCustom?: boolean;
  customGatewayId?: string;
  hasApiKey: boolean;
}

export interface CustomAIGateway {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  defaultModel: string;
  suggestedModels: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AIProviderSettings {
  providerId: string;
  model: string;
  /** Thứ tự provider sẽ được thử khi provider đang chọn hết quota. */
  fallbackOrder: string[];
  providers: AIProviderInfo[];
}

export interface AIProviderTestResult {
  ok: boolean;
  model?: string;
  sample?: string;
  error?: string;
}

/** Giới hạn request/IP. `*WindowMs` và `*Range` do backend quyết định, FE chỉ hiển thị/validate theo. */
export interface RateLimitSettings {
  aiChatLimit: number;
  generalLimit: number;
  aiChatWindowMs: number;
  generalWindowMs: number;
  aiChatRange: { min: number; max: number };
  generalRange: { min: number; max: number };
}

/** Một cột trên biểu đồ token — 'YYYY-MM-DD' với chế độ ngày, 'YYYY-MM' với chế độ tháng. */
export interface TokenUsagePoint {
  period: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}

export interface TokenUsageReport {
  points: TokenUsagePoint[];
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; requestCount: number };
  byModel: { provider: string; model: string; totalTokens: number; requestCount: number }[];
  granularity: 'day' | 'month';
  range: number;
  retentionMonths: number;
}

export const adminApi = {
  // Users
  listUsers: () => api.get('/admin/users').then((r) => r.data),
  createUser: (data: { email: string; password: string; role?: string; defaultKb?: string }) =>
    api.post('/admin/users', data).then((r) => r.data),
  /** Đổi vai trò — chỉ Quản trị hệ thống gọi được (backend chặn). */
  setUserRole: (id: string, role: UserRole) =>
    api.patch(`/admin/users/${id}/role`, { role }).then((r) => r.data),
  /** Đổi KB của tài khoản — với Quản trị KB thì đây chính là phạm vi quyền của họ. */
  setUserDefaultKb: (id: string, defaultKb: string) =>
    api.patch(`/admin/users/${id}/default-kb`, { defaultKb }).then((r) => r.data),
  enableUser: (id: string) => api.patch(`/admin/users/${id}/enable`).then((r) => r.data),
  disableUser: (id: string) => api.patch(`/admin/users/${id}/disable`).then((r) => r.data),
  /** Xoá vĩnh viễn tài khoản (Supabase Auth + bảng users). KHÔNG hoàn tác được. */
  deleteUser: (id: string): Promise<{ success: boolean; id: string; email: string }> =>
    api.delete(`/admin/users/${id}`).then((r) => r.data),
  // Audit
  getAuditLogs: () => api.get('/admin/audit-logs').then((r) => r.data),
  // Analytics
  getAnalytics: () => api.get('/admin/analytics/summary').then((r) => r.data),
  /** Xoá TOÀN BỘ dữ liệu thống kê — không hoàn tác được, phải hỏi xác nhận trước khi gọi */
  deleteAnalytics: (): Promise<{ success: boolean; deleted: number }> =>
    api.delete('/admin/analytics').then((r) => r.data),
  // Keep-alive
  keepAlive: () => api.post('/admin/keep-alive').then((r) => r.data),
  getKeepAliveStatus: () => api.get('/admin/keep-alive').then((r) => r.data),
  // Threshold Settings
  getThreshold: () => api.get('/admin/settings/threshold').then((r) => r.data),
  updateThreshold: (threshold: number) => api.patch('/admin/settings/threshold', { threshold }).then((r) => r.data),
  // Rate Limit Settings — số request tối đa/IP. Cửa sổ thời gian cố định phía backend.
  getRateLimit: (): Promise<RateLimitSettings> =>
    api.get('/admin/settings/rate-limit').then((r) => r.data),
  updateRateLimit: (aiChatLimit: number, generalLimit: number) =>
    api.patch('/admin/settings/rate-limit', { aiChatLimit, generalLimit }).then((r) => r.data),
  // Related Links Count Settings
  getRelatedLinksCount: () => api.get('/admin/settings/related-links-count').then((r) => r.data),
  updateRelatedLinksCount: (count: number) =>
    api.patch('/admin/settings/related-links-count', { count }).then((r) => r.data),
  // AI Chat Provider Settings
  getAIProvider: (): Promise<AIProviderSettings> =>
    api.get('/admin/settings/ai-provider').then((r) => r.data),
  updateAIProvider: (provider: string, model: string) =>
    api.patch('/admin/settings/ai-provider', { provider, model }).then((r) => r.data),
  // timeout dài hơn mặc định vì phải chờ provider thật sinh câu trả lời mẫu
  testAIProvider: (provider: string, model?: string): Promise<AIProviderTestResult> =>
    api
      .post('/admin/settings/ai-provider/test', { provider, model }, { timeout: 60000 })
      .then((r) => r.data),
  /** Danh sách model THẬT mà key của provider được cấp quyền (khác suggestedModels cứng trong code). */
  listAIProviderModels: (provider: string): Promise<{ supported: boolean; models: string[] }> =>
    api
      .get('/admin/settings/ai-provider/models', { params: { provider }, timeout: 60000 })
      .then((r) => r.data),
  // Custom AI Gateways
  listCustomAIGateways: (): Promise<{ gateways: CustomAIGateway[] }> =>
    api.get('/admin/settings/ai-gateways').then((r) => r.data),
  createCustomAIGateway: (data: {
    name: string;
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    suggestedModels?: string[];
    isActive?: boolean;
  }): Promise<CustomAIGateway> =>
    api.post('/admin/settings/ai-gateways', data).then((r) => r.data),
  updateCustomAIGateway: (
    id: string,
    data: {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      defaultModel?: string;
      suggestedModels?: string[];
      isActive?: boolean;
    },
  ): Promise<CustomAIGateway> =>
    api.put(`/admin/settings/ai-gateways/${id}`, data).then((r) => r.data),
  deleteCustomAIGateway: (id: string): Promise<{ success: boolean }> =>
    api.delete(`/admin/settings/ai-gateways/${id}`).then((r) => r.data),
  testDirectCustomGateway: (data: {
    baseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<AIProviderTestResult> =>
    api.post('/admin/settings/ai-gateways/test-direct', data, { timeout: 60000 }).then((r) => r.data),
  listDirectCustomGatewayModels: (data: {
    baseUrl: string;
    apiKey: string;
  }): Promise<{ supported: boolean; models: string[] }> =>
    api.post('/admin/settings/ai-gateways/models-direct', data, { timeout: 60000 }).then((r) => r.data),
  // Thống kê token AI Chat — chỉ phần chat, gộp chung câu hỏi từ web và Telegram
  getTokenUsage: (granularity: 'day' | 'month', range: number): Promise<TokenUsageReport> =>
    api.get('/admin/token-usage', { params: { granularity, range } }).then((r) => r.data),
  /** Xoá thống kê token: một ngày ('YYYY-MM-DD'), một tháng ('YYYY-MM'), hoặc tất cả. */
  deleteTokenUsage: (
    target: { date: string } | { month: string } | { scope: 'all' },
  ): Promise<{ success: boolean; deleted: number; target: string }> =>
    api.delete('/admin/token-usage', { params: target }).then((r) => r.data),
  // Reindex
  reindexAll: () => api.post('/admin/reindex').then((r) => r.data),
  retryFailedReindex: () => api.post('/admin/reindex/retry-failed').then((r) => r.data),
  getReindexStatus: () => api.get('/admin/reindex/status').then((r) => r.data),
  // Publish All (Đăng toàn bộ Draft)
  publishAll: () => api.post('/admin/publish-all').then((r) => r.data),
  getPublishAllStatus: () => api.get('/admin/publish-all/status').then((r) => r.data),
};

// ─── Slang Dictionary (Admin only) ───────────────────────────────────────────
export const slangApi = {
  list: (params?: { type?: string; search?: string; activeOnly?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.search) query.set('search', params.search);
    if (params?.activeOnly) query.set('activeOnly', 'true');
    return api.get(`/admin/slang?${query.toString()}`).then((r) => r.data);
  },
  create: (data: {
    slangTerm: string;
    normalizedEntity: string;
    targetType: string;
    notes?: string;
    isActive?: boolean;
  }) => api.post('/admin/slang', data).then((r) => r.data),
  update: (id: string, data: Partial<{
    slangTerm: string;
    normalizedEntity: string;
    targetType: string;
    notes: string | null;
    isActive: boolean;
  }>) => api.patch(`/admin/slang/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/admin/slang/${id}`).then((r) => r.data),
  export: () => api.get('/admin/slang/export').then((r) => r.data),
};

// ─── Uploads (ảnh minh hoạ — Supabase Storage) ───────────────────────────────
export const uploadsApi = {
  uploadImage: (imageBase64: string): Promise<{ url: string }> =>
    api.post('/uploads/image', { imageBase64 }).then((r) => r.data),
  uploadImageFromUrl: (imageUrl: string): Promise<{ url: string }> =>
    api.post('/uploads/from-url', { imageUrl }).then((r) => r.data),
};

// ─── Nodes (Tree: Folder / Article) ──────────────────────────────────────────
export interface TreeNodeDTO {
  id: string;
  name: string;
  type: 'folder' | 'article';
  status: 'draft' | 'published';
  parentId: string | null;
  sortOrder: number;
  body?: unknown; // TiptapDoc — xem frontend/src/data/docModel.ts
  hasBeenSaved: boolean;
  isProvider: boolean;
  children?: TreeNodeDTO[];
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const nodesApi = {
  /** Lấy toàn bộ cây phân cấp */
  getTree: (): Promise<TreeNodeDTO[]> => api.get('/nodes/tree').then((r) => r.data),
  /** Lấy chi tiết 1 node */
  getById: (id: string): Promise<TreeNodeDTO> => api.get(`/nodes/${id}`).then((r) => r.data),
  /** Tạo Folder hoặc Article mới. Article không cần `name` — theo Folio Workflow Spec,
   * Article tạo ngay với tên rỗng, không hỏi tên trước (Folder vẫn bắt buộc có tên). */
  create: (data: {
    name?: string;
    type: 'folder' | 'article';
    parentId?: string | null;
  }): Promise<TreeNodeDTO> => api.post('/nodes', data).then((r) => r.data),
  /** Cập nhật tên hoặc body (Draft) */
  update: (id: string, data: { name?: string; body?: unknown }): Promise<TreeNodeDTO> =>
    api.patch(`/nodes/${id}`, data).then((r) => r.data),
  /** Di chuyển node sang parentId mới (null = root) */
  move: (id: string, parentId: string | null): Promise<TreeNodeDTO> =>
    api.patch(`/nodes/${id}/move`, { parentId }).then((r) => r.data),
  /** Sắp xếp lại vị trí toàn bộ node cùng cấp cha parentId (null = root), theo đúng thứ tự orderedIds */
  reorder: (parentId: string | null, orderedIds: string[]): Promise<void> =>
    api.patch('/nodes/reorder', { parentId, orderedIds }).then(() => undefined),
  /** Đánh dấu/bỏ đánh dấu 1 Folder là Provider (sảnh cược) — chỉ Admin, chỉ áp dụng cho Folder */
  setProvider: (id: string, isProvider: boolean): Promise<TreeNodeDTO> =>
    api.patch(`/nodes/${id}/provider`, { isProvider }).then((r) => r.data),
  /** Publish article */
  publish: (id: string): Promise<TreeNodeDTO> =>
    api.post(`/nodes/${id}/publish`).then((r) => r.data),
  /** Xóa node */
  delete: (id: string): Promise<{ success: boolean; parentId: string | null }> =>
    api.delete(`/nodes/${id}`).then((r) => r.data),
};



// ─── Telegram ─────────────────────────────────────────────────────────────────
export type TelegramUserStatus = 'pending' | 'approved' | 'rejected';

export interface TelegramUserDTO {
  id: string;
  telegramId: string;
  username: string | null;
  displayName: string;
  status: TelegramUserStatus;
  requestedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  /** KB mà bot dùng khi trả lời tài khoản Telegram này. */
  kbCode: string;
}

export const telegramApi = {
  /** Danh sách tài khoản Telegram; bỏ trống status = lấy tất cả */
  list: (status?: TelegramUserStatus | 'all'): Promise<TelegramUserDTO[]> =>
    api.get(`/admin/telegram${status && status !== 'all' ? `?status=${status}` : ''}`).then((r) => r.data),
  /** Số yêu cầu đang chờ duyệt — dùng cho badge trên tab */
  pendingCount: (): Promise<{ count: number }> =>
    api.get('/admin/telegram/pending-count').then((r) => r.data),
  /** Duyệt: cho phép tài khoản này chat với bot */
  approve: (id: string): Promise<TelegramUserDTO> =>
    api.patch(`/admin/telegram/${id}/approve`).then((r) => r.data),
  /** Từ chối một yêu cầu đang chờ duyệt */
  reject: (id: string): Promise<TelegramUserDTO> =>
    api.patch(`/admin/telegram/${id}/reject`).then((r) => r.data),
  /** Thu hồi quyền của tài khoản ĐÃ được duyệt trước đó */
  revoke: (id: string): Promise<TelegramUserDTO> =>
    api.patch(`/admin/telegram/${id}/revoke`).then((r) => r.data),
  /** Gán KB cho tài khoản — bot tra cột này để biết trả lời bằng dữ liệu của KB nào */
  setKb: (id: string, kbCode: string): Promise<TelegramUserDTO> =>
    api.patch(`/admin/telegram/${id}/kb`, { kbCode }).then((r) => r.data),
  /** Xoá hẳn bản ghi — người đó nhắn bot lần sau sẽ tạo lại yêu cầu mới */
  delete: (id: string): Promise<{ success: boolean }> =>
    api.delete(`/admin/telegram/${id}`).then((r) => r.data),
};
