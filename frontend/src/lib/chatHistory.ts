/**
 * Lịch sử hội thoại AI Chat — lưu ở `sessionStorage`, TÁCH RIÊNG THEO TỪNG TAB.
 *
 * Vì sao không để backend đọc từ `analytics_events` theo `user_id` như trước: nhiều nhân viên
 * CSKH dùng chung một tài khoản, nên câu hỏi của họ nằm lẫn trong cùng cửa sổ 15 phút và bước
 * ghép ngữ cảnh của AI sẽ lấy chủ đề của người này gán vào câu hỏi của người kia. Người dùng
 * không nhìn thấy bước ghép đó nên chỉ thấy câu trả lời lệch chủ đề mà không hiểu vì sao.
 *
 * Chọn `sessionStorage` (theo TAB) chứ không phải `localStorage` (theo trình duyệt): hai người
 * dùng chung một máy + chung một profile trình duyệt thì localStorage vẫn lẫn. Nhược điểm của
 * sessionStorage — mở tab mới là mất ngữ cảnh — gần như vô hại ở đây, vì cửa sổ ngữ cảnh vốn
 * chỉ 15 phút.
 *
 * Khoá lưu gồm cả mã KB, nên bấm chuyển sang KB khác là mạch hội thoại tự tách ra, không mang
 * câu hỏi tiếng Việt sang ghép vào câu hỏi tiếng Anh.
 */

export interface ChatHistoryItem {
  /** Nguyên văn câu hỏi người dùng đã gõ. */
  q: string;
  /** Thời điểm hỏi (epoch ms) — backend tự kiểm tra lại cửa sổ 15 phút, không tin client. */
  at: number;
}

/** Giữ khớp với HISTORY_WINDOW_MINUTES bên backend (contextHistory.service.ts). */
const WINDOW_MS = 15 * 60 * 1000;
/** Giữ khớp với HISTORY_IMPORT_LIMIT bên backend. Gửi dư cũng bị backend cắt. */
const MAX_ITEMS = 4;
const MAX_LENGTH = 500;

function storageKey(kbCode: string): string {
  return `chat_history:${kbCode}`;
}

/** Đọc lịch sử còn hạn của KB đang xem, thứ tự CŨ → MỚI. */
export function readChatHistory(kbCode: string): ChatHistoryItem[] {
  try {
    const raw = sessionStorage.getItem(storageKey(kbCode));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const gioiHan = Date.now() - WINDOW_MS;
    return parsed
      .filter(
        (x): x is ChatHistoryItem =>
          !!x && typeof x === 'object' && typeof (x as ChatHistoryItem).q === 'string' && typeof (x as ChatHistoryItem).at === 'number',
      )
      .filter((x) => x.at >= gioiHan)
      .slice(-MAX_ITEMS);
  } catch {
    // sessionStorage bị chặn (chế độ riêng tư) hoặc dữ liệu hỏng → coi như chưa có lịch sử
    return [];
  }
}

/** Ghi thêm một câu hỏi vào lịch sử của KB đang xem. */
export function appendChatHistory(kbCode: string, question: string): void {
  try {
    const item: ChatHistoryItem = { q: question.trim().slice(0, MAX_LENGTH), at: Date.now() };
    if (!item.q) return;
    const next = [...readChatHistory(kbCode), item].slice(-MAX_ITEMS);
    sessionStorage.setItem(storageKey(kbCode), JSON.stringify(next));
  } catch {
    // Không ghi được thì thôi — mất ngữ cảnh còn hơn làm hỏng luồng chat
  }
}

/** Xoá lịch sử của một KB — dùng khi người dùng bấm xoá hội thoại. */
export function clearChatHistory(kbCode: string): void {
  try {
    sessionStorage.removeItem(storageKey(kbCode));
  } catch {
    // bỏ qua
  }
}
