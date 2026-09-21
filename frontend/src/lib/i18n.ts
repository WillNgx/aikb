import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getActiveLocale } from './kb';

/**
 * Đa ngôn ngữ cho giao diện.
 *
 * NGÔN NGỮ BÁM THEO KB ĐANG XEM, không phải một lựa chọn riêng: mỗi Knowledge Base là một ngôn
 * ngữ (`knowledge_bases.locale`), nên chuyển sang ENKB là toàn bộ giao diện đổi sang tiếng Anh.
 * Xem `KbSwitcher.tsx` — chỗ duy nhất gọi `changeLanguage`.
 *
 * CHỈ dịch nhãn/nút/thông báo của giao diện. Nội dung do người dùng nhập (tên bài, tên thư mục,
 * nội dung khuyến mãi, từ điển từ lóng) KHÔNG bao giờ dịch — đó là dữ liệu riêng của từng KB.
 *
 * Từ điển nạp bằng `import()` động nên mỗi ngôn ngữ là một chunk riêng: thêm ngôn ngữ thứ 3-5
 * không làm phình bundle của người chỉ dùng một ngôn ngữ.
 */

/** Ngôn ngữ gốc — cũng là ngôn ngữ lùi về khi một khoá chưa được dịch. */
export const FALLBACK_LOCALE = 'vi';

const loaders: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  vi: () => import('../locales/vi'),
  en: () => import('../locales/en'),
};

export function isSupportedLocale(lng: string): boolean {
  return lng in loaders;
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
 */
export async function setupI18n(): Promise<void> {
  const lng = getActiveLocale();

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

  await loadLocale(lng);
  if (lng !== FALLBACK_LOCALE) await loadLocale(FALLBACK_LOCALE); // để cơ chế lùi về hoạt động
}

/** Đổi ngôn ngữ giao diện (nạp từ điển trước rồi mới đổi, tránh nháy chữ). */
export async function changeLocale(lng: string): Promise<void> {
  await loadLocale(lng);
  await i18n.changeLanguage(isSupportedLocale(lng) ? lng : FALLBACK_LOCALE);
}

export default i18n;
