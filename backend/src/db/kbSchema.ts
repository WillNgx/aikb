import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn, PgTableWithColumns } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { nodeStatusEnum, nodeTypeEnum, slangTargetTypeEnum } from './enums';

/**
 * SÁU BẢNG NỘI DUNG của một KB, sinh ra từ MỘT định nghĩa duy nhất.
 *
 * Mỗi KB (kb_vi, kb_en, kb_ind...) có một bộ 6 bảng này nằm trong một schema Postgres riêng.
 * Cách ly ở tầng schema chứ không phải bằng cột `kb_id` + `WHERE`: rủi ro lớn nhất của hệ nhiều
 * ngôn ngữ là RÒ CHÉO, mà `gemini-embedding-001` lại là model đa ngôn ngữ — đo thực tế cho thấy
 * câu hỏi tiếng Anh khớp chunk tiếng Việt ở 0.62-0.69 trong khi ngưỡng đang đặt là 0.6. Quên lọc
 * đúng MỘT chỗ là AI trả lời câu tiếng Anh bằng tài liệu tiếng Việt, trôi chảy tới mức không ai
 * phát hiện ra. Tách schema thì việc "quên lọc" không còn tồn tại về mặt vật lý.
 *
 * Định nghĩa cột được viết ĐÚNG MỘT LẦN ở đây rồi sinh ra nhiều bộ bảng, nên không có chuyện
 * schema của kb_en lệch khỏi kb_vi vì sửa chỗ này quên chỗ kia.
 *
 * ⚠️ Thêm/bớt cột ở đây là đổi cấu trúc của TẤT CẢ các KB — migration phải chạy cho từng schema.
 */

// Custom type cho vector (pgvector) — 768 chiều, khớp `gemini-embedding-001`.
// Extension `vector` cài ở schema `extensions` và `extensions` đã nằm trong `search_path` của
// role ứng dụng, nên bảng nằm ở schema nào thì toán tử `<=>` vẫn giải được.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(768)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(Number);
  },
});

/** Bảng dùng chung mà bảng nội dung phải tham chiếu tới (khoá ngoại liên schema — Postgres cho phép). */
export interface KbTableDeps {
  users: PgTableWithColumns<{
    name: 'users';
    schema: undefined;
    columns: { id: AnyPgColumn };
    dialect: 'pg';
  }>;
}

type TableFn = typeof pgTable;

/**
 * Sinh bộ bảng nội dung cho một schema.
 *
 * @param schemaName `null` = dùng schema mặc định (`public`). Truyền `null` cho KB tiếng Việt
 *   ở giai đoạn hiện tại: dữ liệu vẫn nằm nguyên ở `public`, việc chuyển sang `kb_vi` là một
 *   migration riêng chạy sau. Dùng `pgTable` thay vì `pgSchema('public').table` là CỐ Ý — để
 *   snapshot của drizzle-kit không đổi một byte nào so với trước khi tách file này ra.
 */
export function makeKbTables(schemaName: string | null, deps: KbTableDeps) {
  // `pgSchema(x).table` có cùng chữ ký với `pgTable`; ép kiểu ở đúng một chỗ này thay vì rải
  // generic khắp 6 bảng bên dưới.
  const t: TableFn = schemaName
    ? (pgSchema(schemaName).table as unknown as TableFn)
    : pgTable;

  const { users } = deps;

  // ─── nodes ──────────────────────────────────────────────────────────────────
  // Cây thư mục phân cấp (Folder/Article). parentId = null nghĩa là root level.
  // body lưu 1 tài liệu TipTap (ProseMirror JSON doc — editor.getJSON()) dạng JSONB, kiểu nhập
  // liệu liên tục giống Word (chỉ dùng khi type = 'article'). Xem frontend/src/data/docModel.ts.
  //
  // status KHÔNG phải cờ set thủ công — được tính lại (xem computeNodeStatus trong
  // nodeStatus.util.ts) bằng cách so sánh name/body hiện tại với publishedName/publishedBody
  // (bản Đăng gần nhất), rồi mới ghi vào cột này. hasBeenSaved đánh dấu "đã từng
  // Lưu/Đăng ít nhất 1 lần" — khác với status, dùng để biết một Article vừa tạo mà
  // chưa từng lưu (Hủy ở trạng thái này phải xóa hẳn, không có gì để quay lại).
  const nodes = t(
    'nodes',
    {
      id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
      name: text('name').notNull(),
      type: nodeTypeEnum('type').notNull(),
      parentId: uuid('parent_id').references((): AnyPgColumn => nodes.id, { onDelete: 'cascade' }), // Self-reference — null = root level
      status: nodeStatusEnum('status').notNull().default('draft'),
      body: jsonb('body'),         // TipTap JSON doc — chỉ dùng với type='article'
      hasBeenSaved: boolean('has_been_saved').notNull().default(false),
      publishedName: text('published_name'), // Snapshot bản Đăng gần nhất (DEC-04 áp dụng cho nodes)
      publishedBody: jsonb('published_body'),
      sortOrder: integer('sort_order').notNull().default(0),
      // Đánh dấu 1 Folder là "Provider" (sảnh cược) — chỉ Admin toggle được, chỉ có ý nghĩa với
      // type='folder'. Article nằm trong cây con của folder này (folder tổ tiên gần nhất có cờ
      // này) sẽ được index với provider = đúng tên folder đó (xem indexing.service.ts).
      isProvider: boolean('is_provider').notNull().default(false),
      createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
      publishedAt: timestamp('published_at', { withTimezone: true }),
    },
    (table) => [
      index('nodes_parent_id_idx').on(table.parentId),
      index('nodes_type_idx').on(table.type),
      index('nodes_status_idx').on(table.status),
    ]
  );

  // ─── content_chunks ─────────────────────────────────────────────────────────
  // DEC-06: chunk theo section/heading, embedding vector 768d + tsvector keyword
  // Nguồn duy nhất là bảng `nodes` (cây Folder/Article) — hệ `content` (TipTap) cũ đã bị xóa
  // hoàn toàn khỏi hệ thống.
  const contentChunks = t(
    'content_chunks',
    {
      id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
      nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'cascade' }),
      sectionTitle: text('section_title'),
      // Chỉ số heading (khớp id neo "heading-N" của HeadingAnchor extension phía frontend, xem
      // frontend/src/extensions/HeadingAnchor.ts) — dùng để AI chat trỏ link thẳng tới đúng vị trí
      // heading trong bài viết thay vì chỉ tới đầu bài. null nếu chunk nằm trước heading đầu tiên
      // hoặc bài viết không có heading nào.
      headingIndex: integer('heading_index'),
      chunkText: text('chunk_text').notNull(),
      chunkIndex: integer('chunk_index').notNull(),
      embedding: vector('embedding'),
      // Không còn dùng để search (search dùng GIN expression index bên dưới) — giữ cột lại
      // để tránh migration rename-ambiguous với node_id mới thêm; có thể dọn ở migration sau.
      searchVector: text('search_vector'),
      // ── Denormalized Metadata (Hierarchical RAG filter) ────────────────────
      category: text('category'),
      subCategory: text('sub_category'),
      provider: text('provider'),
      platform: text('platform'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index('content_chunks_node_id_idx').on(table.nodeId),
      index('content_chunks_category_idx').on(table.category),
      index('content_chunks_provider_idx').on(table.provider),
      // Expression GIN index — tsvector tính trực tiếp từ chunk_text, khớp đúng truy vấn keyword
      // search dùng trong search.service.ts (không cần cột search_vector riêng nữa).
      index('content_chunks_fts_idx').using('gin', sql`to_tsvector('simple', ${table.chunkText})`),
    ]
  );

  // ─── slang_dictionary ───────────────────────────────────────────────────────
  // Bảng từ điển từ lóng / synonym — chỉ Admin được quản lý (P-Risk-2).
  // Phải theo KB: bước chuẩn hoá thay chữ THẲNG vào câu hỏi trước khi tạo embedding, nên từ
  // điển tiếng Việt áp lên câu hỏi tiếng Anh có thể phá câu.
  const slangDictionary = t(
    'slang_dictionary',
    {
      id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
      slangTerm: text('slang_term').notNull(),           // Từ lóng VD: sapa, tài xỉu, kèo rung
      normalizedEntity: text('normalized_entity').notNull(), // Thuật ngữ chuẩn VD: Saba, Over/Under
      targetType: slangTargetTypeEnum('target_type').notNull().default('general'),
      notes: text('notes'),                              // Giải nghĩa / ngữ cảnh sử dụng
      isActive: boolean('is_active').notNull().default(true),
      createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index('slang_dictionary_term_idx').on(table.slangTerm),
      index('slang_dictionary_type_idx').on(table.targetType),
    ]
  );

  // ─── kb_settings ────────────────────────────────────────────────────────────
  // Cấu hình RIÊNG của từng KB. Phân chia với `app_settings` (dùng chung toàn hệ thống):
  //   - app_settings: chat_provider, chat_model, giới hạn request, tiến trình re-index
  //     (tiến trình để chung là cố ý — mọi KB dùng chung quota Gemini nên re-index phải xếp
  //     hàng tuần tự, khoá toàn cục chính là thứ ràng buộc điều đó).
  //   - kb_settings:  relevance_threshold, related_links_count, system_prompt.
  const kbSettings = t('kb_settings', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });

  // ─── promotions ─────────────────────────────────────────────────────────────
  // Khuyến mãi — NGUỒN SỰ THẬT riêng, KHÔNG dùng cây `nodes` làm nơi lưu.
  //
  // Lý do tách: khuyến mãi có vòng đời hoàn toàn khác tài liệu wiki — máy sinh, thay theo tuần,
  // có hạn hiệu lực, và không ai biên tập tay. Cho vào `nodes` thì mỗi đợt nhập phải đi qua cơ
  // chế Draft/Published vốn thiết kế cho người biên tập (sửa body -> rơi draft -> gỡ index ->
  // đăng lại), còn hạn hiệu lực thì không có chỗ để lưu.
  //
  // `nodes` vẫn có một BẢN SAO một chiều (xem promotions.service -> mirrorPromotion) chỉ chứa
  // phiên bản mới nhất, để AI Chat/Search dùng CHUNG một pipeline — cả 2 nhánh của search()
  // đều `JOIN nodes`, chunk không gắn node sẽ vô hình với tìm kiếm.
  const promotions = t(
    'promotions',
    {
      id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
      // Tên đã chuẩn hoá (bỏ dấu, gộp khoảng trắng, thường hoá) — khoá nhận diện "cùng một
      // khuyến mãi" giữa các đợt nhập. M88 hay đổi hoa/thường và khoảng trắng trong tên.
      titleKey: text('title_key').notNull().unique(),
      title: text('title').notNull(),
      category: text('category').notNull(), // Danh mục lấy từ nguồn: Nổi bật, Hoàn trả, Hoàn gửi...
      // Sảnh áp dụng — script tự phát hiện từ tên, Admin sửa lại được trên trang Khuyến mãi.
      // Đây là trục phân biệt QUAN TRỌNG NHẤT cho AI: 10 bài "Hoàn trả" trùng nhau 80% từ vựng,
      // thứ duy nhất khác là tên sảnh.
      provider: text('provider'),
      // Admin đã sửa tay provider thì các đợt nhập sau KHÔNG được ghi đè bằng kết quả tự đoán.
      providerLocked: boolean('provider_locked').notNull().default(false),
      // 'YYYY-MM' theo ngày BẮT ĐẦU của phiên bản mới nhất, hoặc 'khong-han' khi nội dung
      // không ghi thời hạn (nhóm Hoàn trả) — dùng để chia trang theo năm/tháng.
      startMonth: text('start_month').notNull(),
      // Bài mirror tương ứng trong cây `nodes`. Cố ý KHÔNG cascade delete ngược lại: xoá bài
      // mirror bằng tay không được làm mất bản ghi khuyến mãi.
      nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
      // Phiên bản mới nhất. Để uuid TRẦN, không đặt FK: hai bảng tham chiếu vòng tròn lẫn nhau
      // sẽ làm thứ tự INSERT bị kẹt (phải có version trước mới có promotion và ngược lại).
      latestVersionId: uuid('latest_version_id'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index('promotions_start_month_idx').on(table.startMonth),
      index('promotions_category_idx').on(table.category),
      index('promotions_provider_idx').on(table.provider),
    ]
  );

  // ─── promotion_versions ─────────────────────────────────────────────────────
  // Mỗi lần nhập dữ liệu mà nội dung khác đi thì sinh thêm 1 phiên bản, bản cũ giữ nguyên.
  // `contentHash` là thứ quyết định có sinh version mới hay không — trùng hash thì bỏ qua hoàn
  // toàn, không ghi lại và không tính embedding lại (đây là cách giữ chi phí đợt nhập hàng tuần
  // ở mức thấp).
  const promotionVersions = t(
    'promotion_versions',
    {
      id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
      promotionId: uuid('promotion_id')
        .notNull()
        .references(() => promotions.id, { onDelete: 'cascade' }),
      // Nhãn hiển thị dạng 'dd.mm.yy' theo ngày BẮT ĐẦU của khuyến mãi (ver 01.04.26 = bắt đầu
      // 01/04/2026). Khuyến mãi không ghi ngày bắt đầu thì lấy theo ngày nhập.
      versionLabel: text('version_label').notNull(),
      startDate: date('start_date'),
      timeText: text('time_text'),   // Nguyên văn dòng thời gian, giữ lại để hiển thị
      summary: text('summary'),
      content: text('content').notNull(),
      contentHash: text('content_hash').notNull(),
      sourceFile: text('source_file'),
      importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index('promotion_versions_promotion_id_idx').on(table.promotionId),
      uniqueIndex('promotion_versions_promotion_hash_idx').on(table.promotionId, table.contentHash),
    ]
  );

  return { nodes, contentChunks, slangDictionary, kbSettings, promotions, promotionVersions };
}

/** Bộ 6 bảng nội dung của một KB. */
export type KbTables = ReturnType<typeof makeKbTables>;
