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
const LOCALE_KEY = 'active_kb_locale';

/** Mã KB mặc định — khớp với DEFAULT_KB_CODE bên backend. */
export const DEFAULT_KB_CODE = 'kb_vi';
/** Ngôn ngữ mặc định của giao diện. */
export const DEFAULT_LOCALE = 'vi';

/**
 * Ngôn ngữ giao diện = `locale` của KB đang xem.
 *
 * Lưu riêng ở localStorage thay vì tra từ danh sách KB, vì i18n phải khởi tạo TRƯỚC khi render
 * (main.tsx) trong khi danh sách KB chỉ có sau một lượt gọi API. Giá trị này được đồng bộ lại
 * mỗi khi danh sách KB tải xong hoặc người dùng chuyển KB (xem KbSwitcher.tsx).
 */
export function getActiveLocale(): string {
  try {
    return localStorage.getItem(LOCALE_KEY) || DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function setActiveLocale(locale: string): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    // bỏ qua
  }
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
export function ensureActiveKb(defaultKb: string): void {
  try {
    if (!localStorage.getItem(STORAGE_KEY) && defaultKb) {
      localStorage.setItem(STORAGE_KEY, defaultKb);
    }
  } catch {
    // bỏ qua
  }
}
