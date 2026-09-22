import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Toàn bộ enum của DB, tách riêng khỏi `schema.ts`.
 *
 * Lý do tách: các bảng NỘI DUNG của từng KB được sinh ra bằng factory trong `kbSchema.ts`, mà
 * factory đó cần dùng enum. Nếu enum vẫn nằm trong `schema.ts` thì `schema.ts` ⇄ `kbSchema.ts`
 * import vòng lẫn nhau. File này không import gì từ hai file kia nên cắt được vòng lặp.
 *
 * Enum trong Postgres là KIỂU DỮ LIỆU dùng chung toàn database, không thuộc schema của bảng —
 * nên dù mỗi KB có bảng `nodes` riêng trong schema riêng, tất cả vẫn dùng chung một
 * `node_type` / `node_status`.
 *
 * `schema.ts` re-export lại toàn bộ file này, nên mọi import cũ (`from '../../db/schema'`)
 * vẫn chạy nguyên như trước.
 */

/**
 * Ba vai trò, xếp theo phạm vi từ rộng tới hẹp:
 *
 *  - `super_admin` — Quản trị hệ thống: toàn quyền trên MỌI KB, cộng thêm các việc ở tầm hệ
 *    thống mà một KB đơn lẻ không được đụng (tạo KB mới, quản lý tài khoản, cấu hình AI chung,
 *    giới hạn truy cập, Telegram, thống kê token).
 *  - `admin` — Quản trị KB: toàn quyền NHƯNG chỉ trong KB mình phụ trách (cột `users.default_kb`).
 *    Xem được nội dung KB khác, không sửa được. Tạo được tài khoản `user` thuộc KB mình.
 *  - `user` — chỉ đọc, trên mọi KB.
 *
 * Phạm vi của Quản trị KB dùng lại `users.default_kb` thay vì thêm cột riêng: mỗi tài khoản chỉ
 * thuộc về đúng một KB, nên một cột "tài khoản này thuộc KB nào" là đủ cho cả hai việc (mở KB
 * nào lúc đăng nhập, và được sửa KB nào).
 */
export const userRoleEnum = pgEnum('user_role', ['super_admin', 'admin', 'user']);

export const auditActionEnum = pgEnum('audit_action', [
  'content_create',
  'content_edit',
  'content_delete',
  'content_publish',
  'content_unpublish',
  'user_create',
  'user_edit',
  'user_enable',
  'user_disable',
  'user_delete',
  'slang_create',
  'slang_edit',
  'slang_delete',
  'node_create',
  'node_edit',
  'node_delete',
  'node_move',
  'node_publish',
  'telegram_approve',
  'telegram_reject',
  'telegram_revoke',
  'telegram_delete',
  'promotion_import',
  'promotion_provider_edit',
  'kb_create',
  // Lưu ở trang System prompt: prompt, câu chào khung chat, các câu AI trả lời sẵn của một KB
  'system_prompt_edit',
]);

export const analyticsEventTypeEnum = pgEnum('analytics_event_type', [
  'search',
  'ai_question',
  'ai_no_answer',
]);

export const slangTargetTypeEnum = pgEnum('slang_target_type', [
  'provider',
  'bet_type',
  'platform',
  'category',
  'general',
]);

export const nodeTypeEnum = pgEnum('node_type', ['folder', 'article']);
export const nodeStatusEnum = pgEnum('node_status', ['draft', 'published']);

export const telegramUserStatusEnum = pgEnum('telegram_user_status', [
  'pending',
  'approved',
  'rejected',
]);
