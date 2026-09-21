/**
 * Quản lý theme Sáng/Tối dùng chung.
 *
 * Trước đây logic này nằm gọn trong AppLayout, mà AppLayout chỉ bọc các trang đã đăng
 * nhập — nên trang Đăng nhập không bao giờ nhận được thuộc tính `data-bs-theme` và luôn
 * hiển thị màu sáng dù người dùng đang để chế độ Tối. Đưa ra đây để `main.tsx` áp dụng
 * theme ngay khi app khởi động, trước cả router.
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'kb_theme_preference';

/**
 * Mặc định SÁNG cho mọi người dùng, không bám theo `prefers-color-scheme` của hệ điều
 * hành nữa — để mọi người vào lần đầu đều thấy giao diện giống nhau, thuận tiện khi
 * hướng dẫn nhau qua ảnh chụp màn hình. Ai đổi thủ công thì lựa chọn đó được nhớ lại.
 */
export function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Trình duyệt chặn localStorage (chế độ riêng tư) — vẫn phải chạy được
  }
  return 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-bs-theme', theme);
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Không lưu được thì vẫn áp dụng cho phiên hiện tại, không chặn thao tác của người dùng
  }
}
