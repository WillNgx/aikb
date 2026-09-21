-- Thêm vai trò "Quản trị hệ thống" (`super_admin`) và loại nhật ký `kb_create`.
--
-- Từ đây hệ thống có 3 vai trò: `super_admin` (toàn quyền mọi KB + việc ở tầm hệ thống),
-- `admin` (chỉ toàn quyền trong KB ghi ở `users.default_kb`), `user` (chỉ đọc).
--
-- ⚠️ KHỐI `user_role` ĐƯỢC VIẾT TAY, thay cho câu `ALTER TYPE ... ADD VALUE` mà drizzle-kit sinh
-- ra. Lý do: drizzle chạy TOÀN BỘ migration trong MỘT transaction, mà PostgreSQL không cho dùng
-- một giá trị enum vừa `ADD VALUE` ngay trong chính transaction đó — trong khi migration này bắt
-- buộc phải UPDATE dữ liệu sang giá trị mới ở câu cuối. Tạo LẠI kiểu (RENAME + CREATE + đổi kiểu
-- cột) thì giá trị mới thuộc về một kiểu được tạo ngay trong transaction này nên dùng được luôn.
--
-- Dữ liệu: mọi tài khoản đang là `admin` được NÂNG lên `super_admin`, để không ai mất quyền vào
-- lúc cập nhật. Sau đó Quản trị hệ thống tự hạ từng người xuống `admin` (Quản trị KB) trong giao
-- diện Quản lý tài khoản. Làm ngược lại (mặc định hạ hết xuống Quản trị KB) sẽ khiến cả đội mất
-- quyền quản lý tài khoản và cấu hình ngay khi deploy.
--
-- Phần `CREATE TABLE custom_ai_gateways` do drizzle-kit sinh kèm đã được BỎ: bảng đó đã tạo ở
-- migration 0015 (file viết tay, không có snapshot nên drizzle-kit tưởng bảng chưa tồn tại).
--
-- Đảo ngược: đưa các tài khoản `super_admin` về `admin`, rồi tạo lại kiểu `user_role` với 2 giá
-- trị như cũ. Giá trị `kb_create` của `audit_action` thì không gỡ được nếu đã có dòng nhật ký
-- dùng tới — cũng không cần gỡ, thừa một giá trị enum là vô hại.

ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'kb_create';--> statement-breakpoint
ALTER TYPE "public"."user_role" RENAME TO "user_role_old";--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('super_admin', 'admin', 'user');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" TYPE "public"."user_role" USING "role"::text::"public"."user_role";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user';--> statement-breakpoint
DROP TYPE "public"."user_role_old";--> statement-breakpoint
UPDATE "users" SET "role" = 'super_admin', "updated_at" = now() WHERE "role" = 'admin';
