import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { auditLogs, knowledgeBases } from '../../db/schema';
import { AppError } from '../../lib/AppError';
import { getDefaultKb, getKb, invalidateKbCache, type KbInfo } from './kb.registry';
import { KB_SETTING_KEYS } from './kbSettings.service';

/**
 * Tạo một Knowledge Base mới NGAY LÚC CHẠY, không cần lập trình viên viết migration.
 *
 * ⚠️ ĐÂY LÀ NGOẠI LỆ CÓ CHỦ Ý của quy tắc "mọi thay đổi cấu trúc DB phải đi qua Drizzle
 * migration" (xem CLAUDE.md). Chủ dự án muốn Quản trị hệ thống tự thêm ngôn ngữ mới từ giao diện.
 * Đánh đổi kèm theo, phải nhớ:
 *
 *   Khi thêm/bớt cột trong `db/kbSchema.ts`, migration do `db:generate` sinh ra CHỈ chạm tới các
 *   KB được khai báo trong `db/schema.ts` (hiện là kb_vi, kb_en). KB tạo bằng nút này KHÔNG có
 *   trong đó nên sẽ bị bỏ sót. Migration đổi cấu trúc bảng nội dung PHẢI viết vòng lặp chạy cho
 *   MỌI schema có trong bảng `knowledge_bases`.
 *
 * Cách tạo bảng: CHÉP NGUYÊN cấu trúc từ KB mặc định đang chạy thật, thay vì dựng lại câu
 * `CREATE TABLE` bằng tay trong code. Chép từ bản đang chạy thì KB mới luôn khớp với hiện trạng
 * DB, kể cả những cột được thêm bằng migration sau này — còn câu lệnh viết cứng trong code sẽ
 * lạc hậu ngay lần đổi cấu trúc đầu tiên mà không ai nhận ra.
 */

/** Sáu bảng nội dung của một KB — cùng danh sách với `makeKbTables` trong `db/kbSchema.ts`. */
const KB_TABLES = [
  'nodes',
  'content_chunks',
  'slang_dictionary',
  'kb_settings',
  'promotions',
  'promotion_versions',
] as const;

/**
 * Mã KB hợp lệ: chỉ chữ thường, số và gạch dưới, bắt buộc tiền tố `kb_`.
 *
 * Mã này đi thẳng vào câu lệnh DDL dưới dạng tên schema (không tham số hoá được), nên đây vừa là
 * quy ước đặt tên vừa là hàng rào chống chèn SQL. Không nới lỏng.
 */
const KB_CODE_PATTERN = /^kb_[a-z0-9_]{2,20}$/;

/**
 * Ngôn ngữ giao diện của KB mới.
 *
 * Cố định tiếng Anh theo yêu cầu của chủ dự án: giao diện mới có hai bộ từ điển (vi/en), nên KB
 * ngôn ngữ thứ ba trở đi dùng tiếng Anh làm ngôn ngữ hệ thống. Nội dung tài liệu bên trong KB thì
 * viết bằng ngôn ngữ nào cũng được — đây chỉ là ngôn ngữ của nhãn/nút trên giao diện.
 */
export const NEW_KB_LOCALE = 'en';

export interface CreateKbInput {
  code: string;
  name: string;
  /** System prompt riêng của KB. Bỏ trống thì AI sẽ trả lời bằng tiếng Việt (prompt mặc định). */
  systemPrompt?: string;
}

/** Ghép tên schema + tên bảng thành định danh đã trích dẫn, dùng cho câu lệnh DDL. */
function qualified(schemaName: string, table: string): string {
  return `"${schemaName}"."${table}"`;
}

/**
 * Đổi tên schema trong một câu lệnh do PostgreSQL sinh ra (`pg_get_constraintdef`,
 * `pg_get_indexdef`).
 *
 * Phải khớp CẢ HAI dạng `kb_vi.` và `"kb_vi".`: PostgreSQL chỉ thêm dấu nháy khi tên bắt buộc
 * phải có. Chỉ thay dạng có nháy là hỏng âm thầm theo kiểu tệ nhất — khoá ngoại của KB mới trỏ
 * ngược về bảng của KB nguồn, và câu tạo index thì báo trùng tên (đó là cách lỗi này lộ ra).
 */
function doiSchema(cauLenh: string, tu: string, sang: string): string {
  const re = new RegExp(`(^|[^\\w"])"?${tu}"?\\.`, 'g');
  return cauLenh.replace(re, `$1"${sang}".`);
}

export async function createKb(
  input: CreateKbInput,
  actor: { id: string; email: string }
): Promise<KbInfo> {
  const code = input.code.trim().toLowerCase();
  const name = input.name.trim();

  if (!KB_CODE_PATTERN.test(code)) {
    throw new AppError(
      400,
      'Mã KB phải bắt đầu bằng "kb_" và chỉ gồm chữ thường, số hoặc gạch dưới (ví dụ: kb_id, kb_th)'
    );
  }
  if (!name) throw new AppError(400, 'Tên hiển thị không được để trống');

  const [trung] = await db
    .select({ code: knowledgeBases.code })
    .from(knowledgeBases)
    .where(sql`${knowledgeBases.code} = ${code} OR ${knowledgeBases.schemaName} = ${code}`)
    .limit(1);
  if (trung) throw new AppError(409, `Knowledge Base "${code}" đã tồn tại`);

  // Schema trùng tên nhưng chưa có trong bảng `knowledge_bases` (ví dụ lần tạo trước hỏng giữa
  // chừng) — dừng lại thay vì đổ bảng mới vào một schema có sẵn dữ liệu lạ.
  const daCoSchema = await db.execute(
    sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${code}`
  );
  if (daCoSchema.rows.length > 0) {
    throw new AppError(
      409,
      `Schema "${code}" đã tồn tại trong cơ sở dữ liệu nhưng chưa được đăng ký. Cần kiểm tra lại trước khi dùng mã này.`
    );
  }

  const nguon = await getDefaultKb();
  const schemaNguon = nguon.schemaName;

  // KB nguồn nằm ở `public` là cấu hình cũ, trước khi bảng nội dung được tách sang schema riêng.
  // Chép từ đó sẽ hỏng: bước đổi tên schema bên dưới cũng đổi luôn `public.users` trong định
  // nghĩa khoá ngoại, khiến KB mới trỏ vào một bảng tài khoản không tồn tại.
  if (schemaNguon === 'public') {
    throw new AppError(
      500,
      'KB mặc định đang nằm ở schema "public" nên không dùng làm mẫu được. Cần chuyển nó sang schema riêng trước khi tạo KB mới.'
    );
  }

  await db.transaction(async (tx) => {
    // Ép mọi tên do PostgreSQL sinh ra (trong pg_get_constraintdef / pg_get_indexdef) đều kèm tên
    // schema đầy đủ. Không có dòng này thì định nghĩa khoá ngoại có thể in ra "REFERENCES nodes"
    // trống schema, và bảng của KB mới sẽ trỏ ngược về KB nguồn — đúng kiểu rò dữ liệu chéo mà
    // toàn bộ thiết kế nhiều KB đang tránh. `SET LOCAL` chỉ sống trong transaction này nên an
    // toàn với pooler dùng lại connection.
    await tx.execute(sql`SET LOCAL search_path = pg_catalog`);

    await tx.execute(sql.raw(`CREATE SCHEMA "${code}"`));

    // 1) Cột + giá trị mặc định. LIKE cố ý KHÔNG kèm INCLUDING ALL: index và ràng buộc tạo theo
    //    kiểu đó sẽ bị PostgreSQL ĐẶT LẠI TÊN theo quy tắc mặc định, lệch khỏi tên mà Drizzle
    //    dùng — migration sau này gọi tên index cũ sẽ không tìm thấy.
    for (const t of KB_TABLES) {
      await tx.execute(
        sql.raw(
          `CREATE TABLE ${qualified(code, t)} (LIKE ${qualified(schemaNguon, t)} INCLUDING DEFAULTS INCLUDING COMMENTS)`
        )
      );
    }

    // 2) Ràng buộc (khoá chính, unique, khoá ngoại, check) — giữ NGUYÊN tên gốc.
    //    Khoá chính/unique làm trước để khoá ngoại có thứ để tham chiếu.
    for (const t of KB_TABLES) {
      const rb = await tx.execute(
        sql`SELECT conname, pg_get_constraintdef(oid) AS def
              FROM pg_constraint
             WHERE conrelid = ${`${schemaNguon}.${t}`}::regclass
             ORDER BY CASE contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'c' THEN 3 ELSE 4 END`
      );
      for (const r of rb.rows as { conname: string; def: string }[]) {
        // Khoá ngoại nội bộ KB phải trỏ vào chính KB mới; khoá ngoại sang `public.users` thì giữ
        // nguyên vì bảng tài khoản dùng chung toàn hệ thống.
        const def = doiSchema(r.def, schemaNguon, code);
        await tx.execute(
          sql.raw(`ALTER TABLE ${qualified(code, t)} ADD CONSTRAINT "${r.conname}" ${def}`)
        );
      }
    }

    // 3) Index thường (index do ràng buộc sinh ra đã có ở bước 2, phải loại ra để không tạo trùng).
    for (const t of KB_TABLES) {
      const idx = await tx.execute(
        sql`SELECT i.relname AS ten, pg_get_indexdef(x.indexrelid) AS def
              FROM pg_index x
              JOIN pg_class i ON i.oid = x.indexrelid
             WHERE x.indrelid = ${`${schemaNguon}.${t}`}::regclass
               AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)`
      );
      for (const r of idx.rows as { ten: string; def: string }[]) {
        await tx.execute(sql.raw(doiSchema(r.def, schemaNguon, code)));
      }
    }

    // 4) Đăng ký KB. Xếp cuối danh sách để thứ tự các KB cũ trên giao diện không đổi.
    const [maxOrder] = (
      await tx.execute(sql`SELECT COALESCE(MAX(sort_order), 0) + 1 AS tiep FROM public.knowledge_bases`)
    ).rows as { tiep: number }[];

    await tx.execute(
      sql`INSERT INTO public.knowledge_bases (code, name, locale, schema_name, is_active, sort_order)
          VALUES (${code}, ${name}, ${NEW_KB_LOCALE}, ${code}, true, ${maxOrder.tiep})`
    );

    // 5) System prompt riêng của KB. Tên bảng phải ghép chuỗi (không tham số hoá được) nhưng GIÁ
    //    TRỊ thì luôn truyền dạng tham số — đây là nội dung do người dùng gõ tự do.
    const prompt = input.systemPrompt?.trim();
    if (prompt) {
      await tx.execute(
        sql`INSERT INTO ${sql.raw(qualified(code, 'kb_settings'))} (key, value)
            VALUES (${KB_SETTING_KEYS.systemPrompt}, ${prompt})`
      );
    }
  });

  // Ghi nhật ký NGOÀI transaction: tới đây KB đã tồn tại hợp lệ, một lỗi ghi log không đáng để
  // huỷ bỏ toàn bộ việc tạo KB.
  await db.insert(auditLogs).values({
    action: 'kb_create',
    actorId: actor.id,
    actorEmail: actor.email,
    targetType: 'kb',
    kbCode: code,
    meta: { code, name, locale: NEW_KB_LOCALE, copiedFrom: nguon.code },
  });

  invalidateKbCache();
  return getKb(code);
}
