import { pgTable, uuid, text, timestamp, boolean, jsonb, integer, date, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { makeKbTables } from './kbSchema';
import {
  analyticsEventTypeEnum,
  auditActionEnum,
  telegramUserStatusEnum,
  userRoleEnum,
} from './enums';

/**
 * Sơ đồ DB chia làm hai nhóm:
 *
 *  1. BẢNG DÙNG CHUNG toàn hệ thống — khai báo ngay trong file này, nằm ở schema `public`:
 *     `users`, `knowledge_bases`, `audit_logs`, `analytics_events`, `ai_token_usage`,
 *     `app_settings`, `telegram_users`.
 *  2. BẢNG NỘI DUNG RIÊNG CỦA TỪNG KB — định nghĩa ở `kbSchema.ts`, mỗi KB một bộ trong một
 *     schema Postgres riêng: `nodes`, `content_chunks`, `slang_dictionary`, `kb_settings`,
 *     `promotions`, `promotion_versions`.
 *
 * Enum tách sang `enums.ts` và được re-export ở cuối file, nên mọi import cũ vẫn chạy nguyên.
 */
export * from './enums';

// ─── knowledge_bases ──────────────────────────────────────────────────────────
// Danh sách các KB (mỗi ngôn ngữ một KB: kb_vi, kb_en, kb_ind...).
//
// Mỗi KB có một bộ 6 bảng NỘI DUNG riêng nằm trong schema Postgres riêng
// (`nodes`, `content_chunks`, `promotions`, `promotion_versions`, `slang_dictionary`,
// `kb_settings`). Cách ly ở tầng schema chứ không phải bằng cột `kb_id` + `WHERE`, vì
// rủi ro lớn nhất của hệ nhiều ngôn ngữ là RÒ CHÉO: model embedding `gemini-embedding-001`
// là đa ngôn ngữ, đo thực tế cho thấy câu hỏi tiếng Anh khớp chunk tiếng Việt ở 0.62-0.69
// trong khi ngưỡng đang đặt là 0.6 — quên lọc đúng MỘT chỗ là AI trả lời câu tiếng Anh
// bằng tài liệu tiếng Việt, trôi chảy tới mức không ai phát hiện.
//
// `schemaName` tách riêng khỏi `code` là CỐ Ý: KB tiếng Việt hiện vẫn nằm ở schema `public`,
// việc chuyển sang `kb_vi` là một bước độc lập chạy sau, chỉ cần đổi giá trị cột này.
export const knowledgeBases = pgTable('knowledge_bases', {
  code: text('code').primaryKey(),              // 'kb_vi' | 'kb_en' | ...
  name: text('name').notNull(),                 // Tên hiển thị: 'Tiếng Việt'
  locale: text('locale').notNull(),             // 'vi' | 'en' | 'id' — dùng cho prompt & định dạng
  schemaName: text('schema_name').notNull(),    // Schema Postgres chứa 6 bảng nội dung của KB này
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Mã KB mặc định — cũng là KB duy nhất tồn tại trước khi hệ nhiều ngôn ngữ được bật. */
export const DEFAULT_KB_CODE = 'kb_vi';

// ─── users ────────────────────────────────────────────────────────────────────
// Sync với Supabase Auth (auth.users) — lưu role/enabled riêng ở đây
export const users = pgTable('users', {
  id: uuid('id').primaryKey(), // = Supabase auth.users.id
  email: text('email').notNull().unique(),
  role: userRoleEnum('role').notNull().default('user'),
  enabled: boolean('enabled').notNull().default(true),
  // KB mở mặc định sau khi đăng nhập. CHỈ là mặc định, KHÔNG phải giới hạn quyền: mọi tài
  // khoản đều đọc và ghi được trên mọi KB (quyết định của chủ dự án). Giao diện có cảnh báo
  // khi đang thao tác ngoài KB mặc định của mình, nhưng không chặn.
  //
  // Cố ý KHÔNG đặt khoá ngoại sang `knowledge_bases.code`: cột này có giá trị mặc định nên
  // khoá ngoại sẽ buộc dòng KB phải tồn tại đúng thời điểm chạy migration, làm thứ tự
  // migration phụ thuộc vào dữ liệu. Mã KB là tập đóng, do registry phía backend kiểm soát.
  defaultKb: text('default_kb').notNull().default(DEFAULT_KB_CODE),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Bảng nội dung của KB ─────────────────────────────────────────────────────
// Sáu bảng dưới đây KHÔNG khai báo ở file này mà sinh ra từ factory trong `kbSchema.ts`, vì
// mỗi KB cần một bộ riêng nằm trong schema Postgres riêng của nó.
//
// Bộ export bên dưới là bộ của KB TIẾNG VIỆT, nằm trong schema `kb_vi`.
//
// ⚠️ Đổi tham số schema ở dòng này KHÔNG tự di chuyển dữ liệu. drizzle-kit chỉ so sánh định
// nghĩa với snapshot, thấy bảng "biến mất khỏi schema cũ và xuất hiện ở schema mới" thì nó sinh
// ra `DROP TABLE` + `CREATE TABLE` — tức XOÁ SẠCH dữ liệu. Việc chuyển schema phải làm bằng
// migration VIẾT TAY dùng `ALTER TABLE ... SET SCHEMA` (xem drizzle/0012_*.sql).
//
// drizzle-kit đọc đúng file `./src/db/schema.ts` (xem drizzle.config.ts), nên các bảng phải
// được export TỪ ĐÂY thì lệnh `db:generate` mới nhìn thấy.
export const publicKbTables = makeKbTables('kb_vi', { users });

/**
 * KB tiếng Anh. Thêm một KB = thêm đúng một dòng ở đây + một migration `CREATE TABLE` —
 * KHÔNG phải chép lại định nghĩa bảng (tất cả sinh từ cùng `makeKbTables`, nên schema của các
 * KB không bao giờ lệch nhau).
 *
 * ⚠️ Phải export TỪNG BẢNG một. drizzle-kit quét các export ở cấp cao nhất và chỉ nhận giá trị
 * NÀO LÀ BẢNG — một object bọc nhiều bảng (như `kbEnTables`) bị bỏ qua hoàn toàn, và lệnh
 * `db:generate` sẽ báo "no schema changes" dù đã khai báo đủ.
 *
 * Runtime không dùng trực tiếp các biến này — `kb.registry` tự dựng bộ bảng theo
 * `knowledge_bases.schema_name`.
 */
const kbEnTables = makeKbTables('kb_en', { users });
export const {
  nodes: kbEnNodes,
  contentChunks: kbEnContentChunks,
  slangDictionary: kbEnSlangDictionary,
  kbSettings: kbEnKbSettings,
  promotions: kbEnPromotions,
  promotionVersions: kbEnPromotionVersions,
} = kbEnTables;
export const {
  nodes,
  contentChunks,
  slangDictionary,
  kbSettings,
  promotions,
  promotionVersions,
} = publicKbTables;

// ─── audit_logs ───────────────────────────────────────────────────────────────
// DEC-09: ghi mọi hành động quan trọng, retention 6 tháng
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    action: auditActionEnum('action').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'), // denormalized để lưu lại ngay cả khi user bị xoá
    targetId: uuid('target_id'), // content_id hoặc user_id bị ảnh hưởng
    targetType: text('target_type'), // 'content' | 'user' | 'node'
    meta: jsonb('meta'), // thông tin bổ sung (title cũ, status cũ...)
    // KB nơi thao tác diễn ra. Bảng này DÙNG CHUNG cho mọi KB (chỉ để đối soát, không phải
    // nội dung) — mọi tài khoản đều ghi được trên mọi KB nên cột này là thứ duy nhất truy
    // ngược được "ai đã sửa nội dung của ngôn ngữ nào".
    kbCode: text('kb_code').notNull().default(DEFAULT_KB_CODE),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_created_at_idx').on(table.createdAt),
    index('audit_logs_actor_id_idx').on(table.actorId),
  ]
);

// ─── analytics_events ────────────────────────────────────────────────────────
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    eventType: analyticsEventTypeEnum('event_type').notNull(),
    query: text('query'), // câu search hoặc câu hỏi AI
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    meta: jsonb('meta'), // result count, latency, model, ...
    // KB phát sinh sự kiện. Bảng DÙNG CHUNG vì chỉ phục vụ thống kê.
    //
    // LƯU Ý: bảng này còn bị Context Memory của BOT TELEGRAM đọc lại (`getRecentQuestions`
    // theo `telegramId`). Sau khi lịch sử hội thoại của WEB chuyển sang sessionStorage, đây
    // là chỗ DUY NHẤT còn phải lọc KB bằng tay — quên lọc thì tài khoản Telegram vừa được
    // Admin đổi từ kb_vi sang kb_en sẽ mang câu hỏi tiếng Việt cũ sang ghép vào câu tiếng Anh.
    kbCode: text('kb_code').notNull().default(DEFAULT_KB_CODE),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('analytics_events_type_idx').on(table.eventType),
    index('analytics_events_created_at_idx').on(table.createdAt),
    index('analytics_events_kb_code_idx').on(table.kbCode),
  ]
);

// ─── ai_token_usage ───────────────────────────────────────────────────────────
// Số token AI Chat đã tiêu, GỘP SẴN THEO NGÀY thay vì lưu từng request.
//
// Mỗi (ngày + provider + model) chỉ có đúng 1 dòng, cộng dồn bằng UPSERT — nên 12 tháng dữ liệu
// chỉ cỡ vài nghìn dòng, vẽ biểu đồ không phải quét bảng lớn. Đánh đổi đã biết: không truy ngược
// được câu hỏi nào tốn bao nhiêu token; muốn chi tiết tới từng request thì phải đổi sang lưu raw,
// không "sửa" bảng này được.
//
// usageDate lưu chuỗi 'YYYY-MM-DD' theo GIỜ VIỆT NAM (xem tokenUsage.service), KHÔNG phải UTC:
// người xem biểu đồ hiểu "ngày" theo giờ của họ, để UTC thì câu hỏi lúc 1h sáng bị đếm sang ngày
// hôm trước.
//
// Chỉ tính phần CHAT. Embedding (indexing/search) gọi thẳng Gemini và API embedding không trả về
// số token, nên không có cách đếm chính xác — đừng cộng nhầm hai thứ vào cùng bảng này.
export const aiTokenUsage = pgTable(
  'ai_token_usage',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    usageDate: date('usage_date').notNull(),
    // KB phát sinh lượt hỏi. PHẢI nằm trong unique index bên dưới: UPSERT cộng dồn theo bộ
    // cột đó, thiếu kb_code thì lượt hỏi của kb_en sẽ cộng đè vào dòng của kb_vi.
    kbCode: text('kb_code').notNull().default(DEFAULT_KB_CODE),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique để UPSERT cộng dồn được — onConflictDoUpdate cần đúng bộ cột này
    uniqueIndex('ai_token_usage_date_kb_provider_model_idx').on(
      table.usageDate,
      table.kbCode,
      table.provider,
      table.model
    ),
    index('ai_token_usage_date_idx').on(table.usageDate),
  ]
);

// ─── app_settings ─────────────────────────────────────────────────────────────
// Cấu hình hệ thống: relevance threshold, keep-alive timestamp, v.v.
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── telegram_users ───────────────────────────────────────────────────────────
// Danh sách tài khoản Telegram được phép chat với bot AI.
//
// CỐ Ý KHÔNG có FK tới users.id: đây là bảng ĐỘC LẬP, không map sang tài khoản web.
// Hệ quả đã biết — analytics_events.user_id của câu hỏi từ Telegram luôn NULL, thay vào đó
// telegram.service ghi dấu kênh vào cột meta ({ channel: 'telegram', ... }) để trang Thống kê
// vẫn đếm được. Đừng "sửa" bằng cách thêm FK nếu chưa thống nhất lại.
//
// telegramId để text CHỨ KHÔNG PHẢI integer: ID của Telegram có thể vượt giới hạn int32, và ID
// một số loại chat còn vượt cả số nguyên an toàn của JavaScript — lưu số sẽ sai âm thầm.
//
// Vòng đời: người lạ nhắn bot lần đầu -> bot tự tạo bản ghi 'pending' (tự lấy sẵn id/username/tên
// từ payload Telegram, không ai phải gõ tay) -> Admin duyệt thành 'approved' hoặc 'rejected'.
// 'rejected' KHÔNG bị xoá đi, để lần sau người đó nhắn lại thì không tạo bản ghi pending mới nữa.
export const telegramUsers = pgTable(
  'telegram_users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    telegramId: text('telegram_id').notNull().unique(),
    username: text('username'), // Telegram username, người dùng có thể không đặt
    displayName: text('display_name').notNull(), // first_name + last_name ghép lại
    status: telegramUserStatusEnum('status').notNull().default('pending'),
    // KB mà tài khoản Telegram này được Admin gán — bot tra cột này để biết phải trả lời
    // bằng dữ liệu của KB nào. Nhờ vậy CHỈ CẦN MỘT bot token duy nhất cho mọi ngôn ngữ,
    // không phải tạo bot riêng cho từng KB.
    kbCode: text('kb_code').notNull().default(DEFAULT_KB_CODE),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    // Admin nào đã duyệt/từ chối — KHÁC với việc map người dùng Telegram sang tài khoản web
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('telegram_users_telegram_id_idx').on(table.telegramId),
    index('telegram_users_status_idx').on(table.status),
  ]
);


// ─── custom_ai_gateways ───────────────────────────────────────────────────────
// Danh sách các cổng AI Custom (OpenAI-compatible) do Admin tự cấu hình.
// Lưu trong DB để Admin có thể thêm/sửa/xóa trực tiếp từ giao diện.
export const customAiGateways = pgTable(
  'custom_ai_gateways',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    apiKey: text('api_key').notNull(),
    defaultModel: text('default_model').notNull(),
    suggestedModels: text('suggested_models').array(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('custom_ai_gateways_is_active_idx').on(table.isActive),
  ]
);

// ─── Type exports ─────────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ContentChunk = typeof contentChunks.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type AiTokenUsage = typeof aiTokenUsage.$inferSelect;
export type NewAiTokenUsage = typeof aiTokenUsage.$inferInsert;
export type SlangEntry = typeof slangDictionary.$inferSelect;
export type NewSlangEntry = typeof slangDictionary.$inferInsert;
export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
export type TelegramUser = typeof telegramUsers.$inferSelect;
export type NewTelegramUser = typeof telegramUsers.$inferInsert;
export type KnowledgeBase = typeof knowledgeBases.$inferSelect;
export type NewKnowledgeBase = typeof knowledgeBases.$inferInsert;
export type KbSetting = typeof kbSettings.$inferSelect;
export type Promotion = typeof promotions.$inferSelect;
export type NewPromotion = typeof promotions.$inferInsert;
export type PromotionVersion = typeof promotionVersions.$inferSelect;
export type NewPromotionVersion = typeof promotionVersions.$inferInsert;
export type CustomAiGateway = typeof customAiGateways.$inferSelect;
export type NewCustomAiGateway = typeof customAiGateways.$inferInsert;
