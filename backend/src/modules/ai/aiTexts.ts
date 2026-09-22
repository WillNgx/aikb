import { currentKb } from '../kb/kb.context';
import { getKbSetting } from '../kb/kbSettings.service';

/**
 * Những câu AI trả lời SẴN, không qua model: không tìm thấy thông tin, hỏi lại để chọn sảnh,
 * nhãn nút "so sánh tất cả", cảnh báo chưa có nội dung riêng cho sảnh được hỏi.
 *
 * Mỗi KB tự sửa được ở trang System prompt (lưu trong `kb_settings`), để trống thì dùng câu mặc
 * định theo NGÔN NGỮ CỦA KB — trước đây các câu này viết cứng tiếng Việt nên KB tiếng Anh cũng
 * nhận câu tiếng Việt.
 *
 * Trong câu có thể chèn `{{topic}}` (chủ đề đang hỏi) và `{{provider}}` (tên sảnh).
 */

export const AI_TEXT_KEYS = ['noAnswer', 'clarify', 'compareAll', 'providerNote'] as const;
export type AiTextKey = (typeof AI_TEXT_KEYS)[number];
export type AiTexts = Record<AiTextKey, string>;

/** Khoá trong bảng `kb_settings` của từng câu. */
export const AI_TEXT_SETTING_KEYS: Record<AiTextKey, string> = {
  noAnswer: 'ai_no_answer',
  clarify: 'ai_clarify',
  compareAll: 'ai_compare_all',
  providerNote: 'ai_provider_note',
};

/** Bản tiếng Việt giữ NGUYÊN VĂN các câu cũ, để KB tiếng Việt không đổi gì khi chưa ai sửa. */
const DEFAULTS: Record<'vi' | 'en', AiTexts> = {
  vi: {
    noAnswer:
      'Tôi không tìm thấy thông tin liên quan đến câu hỏi của bạn trong Knowledge Base nội bộ. ' +
      'Vui lòng liên hệ bộ phận phụ trách hoặc thử tìm kiếm với từ khóa khác.',
    clarify: 'Chủ đề "{{topic}}" có quy định riêng theo từng sảnh. Bạn muốn tra cứu thông tin của sảnh nào?',
    compareAll: 'So sánh tất cả',
    providerNote:
      'Chưa tìm thấy nội dung được gắn riêng cho "{{provider}}" — câu trả lời dưới đây chỉ mang tính tham khảo chung, vui lòng xác minh thêm.',
  },
  en: {
    noAnswer:
      'I could not find any information related to your question in the internal Knowledge Base. ' +
      'Please contact the responsible team or try searching with different keywords.',
    clarify: 'The topic "{{topic}}" has different rules for each lounge. Which lounge would you like to look up?',
    compareAll: 'Compare all',
    providerNote:
      'No content is tagged specifically for "{{provider}}" yet — the answer below is general reference only, please double-check.',
  },
};

/** KB nào không phải tiếng Việt thì dùng bản tiếng Anh (hệ thống chỉ có 2 bộ câu mặc định). */
function lang(locale: string): 'vi' | 'en' {
  return locale === 'vi' ? 'vi' : 'en';
}

export function defaultAiTexts(locale: string): AiTexts {
  return DEFAULTS[lang(locale)];
}

/** Câu Admin đã đặt riêng cho KB hiện tại (rỗng = chưa đặt). */
export async function getCustomAiTexts(): Promise<AiTexts> {
  const values = await Promise.all(AI_TEXT_KEYS.map((k) => getKbSetting(AI_TEXT_SETTING_KEYS[k], '')));
  return Object.fromEntries(AI_TEXT_KEYS.map((k, i) => [k, values[i]])) as AiTexts;
}

/** Câu dùng thật cho KB hiện tại: câu Admin đặt, chưa đặt thì câu mặc định theo ngôn ngữ KB. */
export async function getAiTexts(): Promise<AiTexts> {
  const custom = await getCustomAiTexts();
  const def = defaultAiTexts(currentKb().locale);
  return Object.fromEntries(AI_TEXT_KEYS.map((k) => [k, custom[k] || def[k]])) as AiTexts;
}

/** Thay `{{ten}}` bằng giá trị tương ứng; placeholder không có giá trị thì giữ nguyên. */
export function fillText(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, name: string) => vars[name] ?? m);
}

/**
 * Câu hỏi gửi đi khi người dùng bấm chọn sảnh / "so sánh tất cả". Cố ý KHÔNG cho Admin sửa: đây
 * là câu đem đi TÌM KIẾM chứ không phải lời chào hỏi, viết sai là tìm trượt. Bản tiếng Việt giữ
 * nguyên như trước.
 */
export function clarifyQueries(locale: string) {
  return lang(locale) === 'vi'
    ? {
        pickProvider: (q: string, p: string) => `${q} tại sảnh ${p}`,
        compareAll: (topic: string, ps: string[]) => `So sánh ${topic} giữa các sảnh: ${ps.join(', ')}`,
      }
    : {
        pickProvider: (q: string, p: string) => `${q} at ${p}`,
        compareAll: (topic: string, ps: string[]) => `Compare ${topic} across lounges: ${ps.join(', ')}`,
      };
}
