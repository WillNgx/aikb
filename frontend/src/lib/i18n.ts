import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { isVnKb } from './kb';

/**
 * Đa ngôn ngữ cho giao diện.
 *
 * Nút EN/VI (cạnh nút đổi theme) CHỈ có ở VNKB — mọi KB khác giao diện luôn tiếng Anh, không có
 * nút (quyết định của chủ dự án). Lựa chọn EN/VI vẫn được nhớ, quay lại VNKB là có lại. Ngôn ngữ
 * của nội dung bài viết và câu trả lời AI vẫn đi theo KB (header `X-KB` + system prompt của KB).
 *
 * CHỈ dịch nhãn/nút/thông báo của giao diện. Nội dung do người dùng nhập (tên bài, tên thư mục,
 * nội dung khuyến mãi, từ điển từ lóng) KHÔNG bao giờ dịch — đó là dữ liệu riêng của từng KB.
 *
 * Từ điển nạp bằng `import()` động nên mỗi ngôn ngữ là một chunk riêng.
 */

/** Ngôn ngữ gốc — cũng là ngôn ngữ lùi về khi một khoá chưa được dịch. */
export const FALLBACK_LOCALE = 'vi';

/** Ngôn ngữ cho người mới vào lần đầu, và cố định cho trang Đăng nhập. */
export const DEFAULT_UI_LOCALE = 'en';

const UI_LOCALE_KEY = 'ui_locale';
/**
 * Khoá cũ từ hồi ngôn ngữ còn bám theo KB. Chỉ ĐỌC để người đang dùng giữ nguyên ngôn ngữ họ
 * đang thấy (quyết định của chủ dự án); không còn chỗ nào ghi vào khoá này nữa.
 */
const LEGACY_LOCALE_KEY = 'active_kb_locale';

const loaders: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  vi: () => import('../locales/vi'),
  en: () => import('../locales/en'),
};

export function isSupportedLocale(lng: string): boolean {
  return lng in loaders;
}

/** Lựa chọn EN/VI đã lưu (chỉ dùng ở VNKB): lựa chọn mới → lựa chọn cũ theo KB → tiếng Anh. */
function getSavedUiLocale(): string {
  try {
    const lng = localStorage.getItem(UI_LOCALE_KEY) || localStorage.getItem(LEGACY_LOCALE_KEY);
    if (lng && isSupportedLocale(lng)) return lng;
  } catch {
    // Trình duyệt chặn localStorage → dùng mặc định
  }
  return DEFAULT_UI_LOCALE;
}

/** Ngôn ngữ giao diện cho KB đang xem: VNKB theo lựa chọn đã lưu, KB khác luôn tiếng Anh. */
export function getUiLocale(): string {
  return isVnKb() ? getSavedUiLocale() : DEFAULT_UI_LOCALE;
}

/** Nạp từ điển của một ngôn ngữ nếu chưa có. Gọi lại nhiều lần là vô hại. */
export async function loadLocale(lng: string): Promise<void> {
  const ma = isSupportedLocale(lng) ? lng : FALLBACK_LOCALE;
  if (i18n.hasResourceBundle(ma, 'translation')) return;
  const mod = await loaders[ma]();
  i18n.addResourceBundle(ma, 'translation', mod.default, true, true);
}

/**
 * Khởi tạo i18n. PHẢI gọi và chờ xong TRƯỚC khi render (xem main.tsx): render trước rồi mới nạp
 * từ điển sẽ làm toàn bộ giao diện nháy một lượt chữ chưa dịch.
 *
 * Nạp cả 2 từ điển: trang Đăng nhập luôn tiếng Anh, và câu chào khung chat đi theo ngôn ngữ của
 * KB (không theo giao diện) — cả hai cần từ điển khác với ngôn ngữ đang chọn.
 */
export async function setupI18n(): Promise<void> {
  const lng = getUiLocale();

  await i18n.use(initReactI18next).init({
    lng,
    fallbackLng: FALLBACK_LOCALE,
    resources: {},
    interpolation: {
      // React đã tự chống XSS khi render, escape thêm một lần nữa sẽ làm hỏng dấu nháy tiếng Việt
      escapeValue: false,
    },
    returnNull: false,
  });

  await Promise.all(Object.keys(loaders).map(loadLocale));
  document.documentElement.lang = lng;
}

async function applyLocale(lng: string): Promise<void> {
  const ma = isSupportedLocale(lng) ? lng : FALLBACK_LOCALE;
  await loadLocale(ma);
  if (i18n.language !== ma) await i18n.changeLanguage(ma);
  document.documentElement.lang = ma;
}

/** Nút EN/VI (chỉ có ở VNKB): đổi ngôn ngữ giao diện và nhớ lại lựa chọn cho lần mở sau. */
export async function changeLocale(lng: string): Promise<void> {
  try {
    localStorage.setItem(UI_LOCALE_KEY, lng);
  } catch {
    // bỏ qua — vẫn đổi được trong phiên hiện tại
  }
  await applyLocale(lng);
}

/** Áp lại ngôn ngữ sau khi đổi KB (KHÔNG ghi đè lựa chọn EN/VI đã lưu). */
export function syncUiLocale(): Promise<void> {
  return applyLocale(getUiLocale());
}

/**
 * Tên ngôn ngữ viết bằng CHÍNH ngôn ngữ đó (cố ý không dịch): người không đọc được ngôn ngữ đang
 * hiển thị vẫn nhận ra nút để chuyển về ngôn ngữ của mình.
 */
export const LOCALE_NAMES: Record<string, string> = { vi: 'Tiếng Việt', en: 'English' };

/** Ngôn ngữ từ điển dùng cho một KB: KB nào không phải tiếng Việt thì dùng tiếng Anh. */
export function localeOfKb(kbLocale: string | undefined): string {
  return kbLocale && isSupportedLocale(kbLocale) ? kbLocale : DEFAULT_UI_LOCALE;
}

export default i18n;
