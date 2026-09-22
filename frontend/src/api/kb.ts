import { useQuery } from '@tanstack/react-query';
import api from './client';
import i18n, { localeOfKb } from '../lib/i18n';
import { getActiveKb } from '../lib/kb';

/**
 * Danh sách Knowledge Base (mỗi ngôn ngữ một KB: kb_vi, kb_en, kb_ind...).
 *
 * Frontend chỉ cần biết mã + tên KB; dữ liệu nội dung của KB nào nằm ở đâu là chuyện của
 * backend. Mã KB đang chọn được gửi kèm MỌI request qua header `X-KB` (xem `api/client.ts`).
 */

export interface KbInfo {
  code: string;
  name: string;
  locale: string;
  sortOrder: number;
  /** Câu chào khung chat do Admin đặt; rỗng/thiếu (backend cũ) = dùng câu mặc định. */
  chatGreeting?: string;
}

/** Các câu AI trả lời sẵn — khoá khớp AI_TEXT_KEYS bên backend (modules/ai/aiTexts.ts). */
export const AI_TEXT_KEYS = ['noAnswer', 'clarify', 'compareAll', 'providerNote'] as const;
export type AiTextKey = (typeof AI_TEXT_KEYS)[number];
export type AiTexts = Record<AiTextKey, string>;

/** Một dòng trên trang System prompt: prompt hiện tại của một KB + có được sửa hay không. */
export interface KbSystemPrompt {
  code: string;
  name: string;
  locale: string;
  systemPrompt: string;
  /** Câu chào mở đầu khung chat — rỗng = câu mặc định theo ngôn ngữ của KB. */
  chatGreeting: string;
  /** Câu AI trả lời sẵn Admin đã đặt (rỗng = chưa đặt) và câu mặc định theo ngôn ngữ KB. */
  aiTexts: AiTexts;
  aiTextDefaults: AiTexts;
  /** Chưa đặt prompt riêng → AI đang dùng prompt mặc định (tiếng Việt). */
  isDefault: boolean;
  /** Quản trị hệ thống sửa được mọi KB; Quản trị KB chỉ sửa được KB mình phụ trách. */
  canEdit: boolean;
}

/** Những gì trang System prompt gửi lên khi bấm Lưu. */
export interface KbPromptFields {
  systemPrompt: string;
  chatGreeting: string;
  aiTexts: AiTexts;
}

export const kbApi = {
  list: (): Promise<KbInfo[]> => api.get('/kb').then((r) => r.data.items),
  /** Tạo KB mới — chỉ Quản trị hệ thống (backend chặn, đây chỉ là lời gọi). */
  create: (data: { code: string; name: string; systemPrompt?: string }): Promise<KbInfo> =>
    api.post('/kb', data).then((r) => r.data),
  listSystemPrompts: (): Promise<KbSystemPrompt[]> =>
    api.get('/kb/system-prompts').then((r) => r.data.items),
  saveSystemPrompt: (code: string, data: KbPromptFields) =>
    api.put(`/kb/${code}/system-prompt`, data).then((r) => r.data),
};

export function useKbList() {
  return useQuery<KbInfo[]>({
    queryKey: ['kb-list'],
    queryFn: kbApi.list,
    // Danh sách KB gần như không đổi — không cần hỏi lại server mỗi lần đổi trang.
    staleTime: 10 * 60 * 1000,
  });
}

/** Câu mặc định (chưa đặt riêng) của khung chat, viết bằng ngôn ngữ của KB. */
export function defaultChatText(kbLocale: string | undefined, key: 'greeting' | 'cleared'): string {
  return i18n.getFixedT(localeOfKb(kbLocale))(`chat.${key}`);
}

/**
 * Lời của AI trong khung chat (câu chào + câu sau khi làm mới hội thoại) của KB ĐANG XEM.
 *
 * Đi theo NGÔN NGỮ CỦA KB chứ không theo nút EN/VI — AI trả lời bằng ngôn ngữ của KB, nên chào
 * một đằng trả lời một nẻo sẽ rất lạ. Câu chào do Admin từng KB tự đặt ở trang System prompt.
 */
export function useKbChatText(): { greeting: string; cleared: string } {
  const { data: ds = [] } = useKbList();
  const kb = ds.find((k) => k.code === getActiveKb());
  return {
    greeting: kb?.chatGreeting || defaultChatText(kb?.locale, 'greeting'),
    cleared: defaultChatText(kb?.locale, 'cleared'),
  };
}
