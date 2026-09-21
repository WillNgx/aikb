-- Chuyển 6 bảng NỘI DUNG của KB tiếng Việt từ schema `public` sang schema riêng `kb_vi`.
--
-- ⚠️ NỘI DUNG FILE NÀY ĐƯỢC VIẾT TAY, thay cho phần `CREATE TABLE` mà drizzle-kit tự sinh.
-- drizzle-kit không phân biệt được "chuyển schema" với "xoá rồi tạo lại": nó thấy bảng biến mất
-- khỏi `public` và xuất hiện ở `kb_vi` nên viết ra DROP + CREATE — chạy vào là mất sạch dữ liệu.
--
-- `ALTER TABLE ... SET SCHEMA` KHÔNG chép một byte dữ liệu nào, chỉ đổi chỗ khai báo trong
-- catalog, nên chạy gần như tức thì kể cả với `content_chunks` (1.043 vector 768 chiều).
-- Index, khoá ngoại và ràng buộc đều đi theo bảng.
--
-- An toàn đã kiểm tra trước khi chạy:
--   - Không có view / trigger tự tạo / function nào trong `public` phụ thuộc 6 bảng này.
--   - Không có khoá ngoại nào từ bảng Ở LẠI trỏ vào bảng SẼ CHUYỂN (trường hợp duy nhất gây vỡ).
--   - Khoá ngoại sang `public.users` trở thành khoá ngoại liên schema — Postgres cho phép.
--   - Extension `vector` nằm ở schema `extensions`, đã có trong `search_path` của role ứng dụng,
--     nên toán tử `<=>` vẫn giải được sau khi bảng đổi schema.
--
-- Đảo ngược: đổi `kb_vi` thành `public` trong khối bên dưới và đặt lại `schema_name = 'public'`.

CREATE SCHEMA IF NOT EXISTS "kb_vi";
--> statement-breakpoint
-- Bọc điều kiện tồn tại để lệnh CHẠY LẠI ĐƯỢC: nếu migration bị chạy lần hai (hoặc bảng đã được
-- chuyển bằng tay trước đó) thì đây chỉ là no-op, không ném lỗi "relation does not exist".
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['nodes','content_chunks','slang_dictionary',
                           'kb_settings','promotions','promotion_versions']
  LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA kb_vi', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
UPDATE "knowledge_bases"
   SET "schema_name" = 'kb_vi', "updated_at" = now()
 WHERE "code" = 'kb_vi';
