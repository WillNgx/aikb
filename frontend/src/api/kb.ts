import { useQuery } from '@tanstack/react-query';
import api from './client';

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
}

/** Một dòng trên trang System prompt: prompt hiện tại của một KB + có được sửa hay không. */
export interface KbSystemPrompt {
  code: string;
  name: string;
  locale: string;
  systemPrompt: string;
  /** Chưa đặt prompt riêng → AI đang dùng prompt mặc định (tiếng Việt). */
  isDefault: boolean;
  /** Quản trị hệ thống sửa được mọi KB; Quản trị KB chỉ sửa được KB mình phụ trách. */
  canEdit: boolean;
}

export const kbApi = {
  list: (): Promise<KbInfo[]> => api.get('/kb').then((r) => r.data.items),
  /** Tạo KB mới — chỉ Quản trị hệ thống (backend chặn, đây chỉ là lời gọi). */
  create: (data: { code: string; name: string; systemPrompt?: string }): Promise<KbInfo> =>
    api.post('/kb', data).then((r) => r.data),
  listSystemPrompts: (): Promise<KbSystemPrompt[]> =>
    api.get('/kb/system-prompts').then((r) => r.data.items),
  saveSystemPrompt: (code: string, systemPrompt: string) =>
    api.put(`/kb/${code}/system-prompt`, { systemPrompt }).then((r) => r.data),
};

export function useKbList() {
  return useQuery<KbInfo[]>({
    queryKey: ['kb-list'],
    queryFn: kbApi.list,
    // Danh sách KB gần như không đổi — không cần hỏi lại server mỗi lần đổi trang.
    staleTime: 10 * 60 * 1000,
  });
}
