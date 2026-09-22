/**
 * KB (Knowledge Base) đang được xem.
 *
 * Mỗi ngôn ngữ là một KB riêng (kb_vi, kb_en, kb_ind...), dữ liệu nội dung nằm ở schema Postgres
 * riêng bên backend. Frontend chỉ cần gửi mã KB kèm MỌI request qua header `X-KB`; backend tự
 * mở ngữ cảnh và khoá mọi truy vấn vào đúng KB đó.
 *
 * Lưu ở `localStorage` chứ không phải `sessionStorage`: lựa chọn "tôi làm việc với KB nào" nên
 * được nhớ lại giữa các lần mở trình duyệt, khác với lịch sử hội thoại (chỉ theo tab — xem
 * `lib/chatHistory.ts`).
 */

const STORAGE_KEY = 'active_kb';

/** Mã KB mặc định — khớp với DEFAULT_KB_CODE bên backend. */
export const DEFAULT_KB_CODE = 'kb_vi';

/**
 * VNKB — KB DUY NHẤT có nút đổi ngôn ngữ giao diện EN/VI; mọi KB khác giao diện luôn tiếng Anh
 * (quyết định của chủ dự án, xem lib/i18n.ts). So theo mã chứ không theo `locale` của KB vì
 * i18n phải biết ngôn ngữ NGAY lúc khởi động, trước khi danh sách KB tải xong.
 */
export const VN_KB_CODE = 'kb_vi';

export function isVnKb(code: string = getActiveKb()): boolean {
  return code === VN_KB_CODE;
}

export function getActiveKb(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_KB_CODE;
  } catch {
    return DEFAULT_KB_CODE;
  }
}

export function setActiveKb(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Trình duyệt chặn localStorage → vẫn chạy được với KB mặc định
  }
}

/**
 * Đặt KB đang xem theo KB mặc định của tài khoản, NHƯNG chỉ khi người dùng chưa từng tự chọn.
 *
 * Gọi sau khi đăng nhập: tài khoản của đội tiếng Anh mở lên là vào thẳng ENKB. Nếu người dùng
 * đã tự chuyển sang KB khác thì tôn trọng lựa chọn đó, không ghi đè mỗi lần vào lại trang.
 */
/** Trả `true` nếu vừa đặt KB (lần đầu) — lúc đó nơi gọi phải áp lại ngôn ngữ giao diện. */
export function ensureActiveKb(defaultKb: string): boolean {
  try {
    if (!localStorage.getItem(STORAGE_KEY) && defaultKb) {
      localStorage.setItem(STORAGE_KEY, defaultKb);
      return true;
    }
  } catch {
    // bỏ qua
  }
  return false;
}
