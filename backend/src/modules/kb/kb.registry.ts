import { db } from '../../db';
import { DEFAULT_KB_CODE, knowledgeBases, publicKbTables, users } from '../../db/schema';
import { makeKbTables, type KbTables } from '../../db/kbSchema';
import { notFound } from '../../lib/AppError';

/**
 * Danh bạ các KB đang có, và bộ bảng tương ứng của từng KB.
 *
 * Mỗi KB là một ngôn ngữ (kb_vi, kb_en, kb_ind...) với 6 bảng nội dung nằm trong một schema
 * Postgres riêng. Registry này là chỗ DUY NHẤT biết "mã KB nào ứng với schema nào" — mọi nơi
 * khác chỉ xin bộ bảng rồi dùng, không tự dựng tên schema.
 */

export interface KbInfo {
  code: string;
  name: string;
  locale: string;
  schemaName: string;
  isActive: boolean;
  sortOrder: number;
  /** Bộ 6 bảng nội dung của KB này. */
  tables: KbTables;
}

/**
 * Cache 60 giây, cùng cách làm với `getChatConfig()` bên llm.service: danh sách KB gần như
 * không đổi nhưng lại bị đọc ở MỌI request, để query thẳng DB là lãng phí.
 */
const CACHE_MS = 60_000;
let cached: { value: Map<string, KbInfo>; expiresAt: number } | null = null;

/**
 * Bộ bảng đã dựng, giữ lại theo tên schema.
 *
 * Dựng bảng Drizzle không đắt nhưng cũng không miễn phí, mà quan trọng hơn: giữ đúng MỘT đối
 * tượng cho mỗi schema giúp so sánh/gỡ lỗi dễ hơn khi in ra câu SQL.
 */
const tablesBySchema = new Map<string, KbTables>([['public', publicKbTables]]);

function getTablesFor(schemaName: string): KbTables {
  const co = tablesBySchema.get(schemaName);
  if (co) return co;
  // `null` = schema mặc định (public) — xem chú thích trong kbSchema.ts
  const moi = makeKbTables(schemaName === 'public' ? null : schemaName, { users });
  tablesBySchema.set(schemaName, moi);
  return moi;
}

export function invalidateKbCache(): void {
  cached = null;
}

async function loadRegistry(): Promise<Map<string, KbInfo>> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const rows = await db.select().from(knowledgeBases);
  const map = new Map<string, KbInfo>();

  for (const r of rows) {
    map.set(r.code, {
      code: r.code,
      name: r.name,
      locale: r.locale,
      schemaName: r.schemaName,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      tables: getTablesFor(r.schemaName),
    });
  }

  // Hệ thống luôn phải có ít nhất KB mặc định. Bảng rỗng chỉ xảy ra khi ai đó xoá tay dòng
  // dữ liệu — vẫn phải chạy được thay vì sập toàn bộ API.
  if (!map.has(DEFAULT_KB_CODE)) {
    map.set(DEFAULT_KB_CODE, {
      code: DEFAULT_KB_CODE,
      name: 'Tiếng Việt',
      locale: 'vi',
      schemaName: 'public',
      isActive: true,
      sortOrder: 0,
      tables: publicKbTables,
    });
  }

  cached = { value: map, expiresAt: Date.now() + CACHE_MS };
  return map;
}

/** Danh sách KB đang bật, đã sắp xếp — dùng cho nút chuyển KB ở giao diện. */
export async function listActiveKbs(): Promise<KbInfo[]> {
  const map = await loadRegistry();
  return [...map.values()]
    .filter((k) => k.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

/** Lấy một KB theo mã. Ném lỗi nếu mã không tồn tại hoặc KB đã tắt. */
export async function getKb(code: string): Promise<KbInfo> {
  const map = await loadRegistry();
  const kb = map.get(code);
  if (!kb || !kb.isActive) throw notFound(`Knowledge Base "${code}" not found`);
  return kb;
}

/** Có tồn tại và đang bật hay không — dùng để validate đầu vào mà không ném lỗi. */
export async function isValidKb(code: string): Promise<boolean> {
  const map = await loadRegistry();
  return !!map.get(code)?.isActive;
}

/**
 * KB mặc định. Dùng cho tác vụ nền KHÔNG gắn với một request cụ thể mà vẫn buộc phải chọn một
 * KB (ví dụ script nạp dữ liệu chạy tay). Code chạy trong luồng request thì KHÔNG được gọi hàm
 * này — phải lấy KB thật từ ngữ cảnh, xem `kb.context.ts`.
 */
export async function getDefaultKb(): Promise<KbInfo> {
  return getKb(DEFAULT_KB_CODE);
}
