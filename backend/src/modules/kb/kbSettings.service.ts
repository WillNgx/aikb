import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { appSettings } from '../../db/schema';
import { currentKb, kbTables } from './kb.context';

/**
 * Cấu hình RIÊNG của từng KB (bảng `kb_settings` nằm trong schema của chính KB đó).
 *
 * Phân chia với `app_settings` (dùng chung toàn hệ thống):
 *   - app_settings: `chat_provider`, `chat_model`, giới hạn request, tiến trình re-index.
 *     Tiến trình để chung là CỐ Ý — mọi KB dùng chung quota Gemini nên re-index phải xếp hàng
 *     tuần tự, khoá toàn cục chính là thứ ràng buộc điều đó.
 *   - kb_settings:  `relevance_threshold`, `related_links_count`, `system_prompt`, `chat_greeting`.
 *
 * Vì sao ngưỡng phải theo KB: 0.6 hiện tại chọn theo phân bố điểm của tiếng Việt. Đo thực tế
 * cho thấy câu hỏi tiếng Anh khớp chunk tiếng Việt ở 0.62–0.69, tức phân bố điểm giữa các ngôn
 * ngữ lệch nhau thật — dùng chung một ngưỡng sẽ hoặc bỏ sót hoặc nhận rác ở ngôn ngữ khác.
 *
 * CÓ ĐƯỜNG LÙI về `app_settings`: giá trị cũ (đang là 0.6) vẫn nằm ở bảng chung. Đọc kb_settings
 * trước, không có thì lấy app_settings, không có nữa thì lấy mặc định trong code. Nhờ vậy không
 * cần migration dữ liệu — lần đầu Admin bấm Lưu là giá trị chuyển hẳn sang kb_settings.
 */

export const KB_SETTING_KEYS = {
  relevanceThreshold: 'relevance_threshold',
  relatedLinksCount: 'related_links_count',
  systemPrompt: 'system_prompt',
  /** Câu chào mở đầu khung chat. Rỗng = frontend dùng câu mặc định theo ngôn ngữ của KB. */
  chatGreeting: 'chat_greeting',
} as const;

const CACHE_MS = 60_000;
/** Cache theo từng KB — khoá là mã KB, giá trị là toàn bộ bảng cấu hình của KB đó. */
const cache = new Map<string, { value: Map<string, string>; expiresAt: number }>();

export function invalidateKbSettingsCache(kbCode?: string): void {
  if (kbCode) cache.delete(kbCode);
  else cache.clear();
}

async function loadAll(): Promise<Map<string, string>> {
  const code = currentKb().code;
  const hit = cache.get(code);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const map = new Map<string, string>();
  try {
    const { kbSettings } = kbTables();
    const rows = await db.select().from(kbSettings);
    rows.forEach((r) => map.set(r.key, r.value));
  } catch (err) {
    // Bảng chưa tồn tại ở KB mới tạo → dùng đường lùi, không làm chết luồng chat
    console.warn('[KB Settings] Không đọc được kb_settings:', err);
  }

  cache.set(code, { value: map, expiresAt: Date.now() + CACHE_MS });
  return map;
}

/** Đọc một cấu hình của KB hiện tại, có đường lùi về `app_settings` rồi tới giá trị mặc định. */
export async function getKbSetting(key: string, fallback: string): Promise<string> {
  const map = await loadAll();
  const cuaKb = map.get(key);
  if (cuaKb !== undefined) return cuaKb;

  try {
    const [chung] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
    if (chung) return chung.value;
  } catch {
    // Bỏ qua — rơi xuống giá trị mặc định
  }
  return fallback;
}

export async function getKbNumberSetting(key: string, fallback: number): Promise<number> {
  const raw = await getKbSetting(key, String(fallback));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Ghi cấu hình cho KB hiện tại. */
export async function setKbSetting(key: string, value: string): Promise<void> {
  const { kbSettings } = kbTables();
  await db
    .insert(kbSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: kbSettings.key, set: { value, updatedAt: new Date() } });
  invalidateKbSettingsCache(currentKb().code);
}
