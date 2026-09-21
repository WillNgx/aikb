-- Khoá mọi bảng của app trước hai vai trò `anon` / `authenticated` của Supabase.
--
-- VÌ SAO: Supabase tự mở schema `public` ra REST API (PostgREST) và anon key lại nằm công khai trong
-- bundle frontend. Trước migration này, 4 bảng `custom_ai_gateways` (chứa API key), `telegram_users`,
-- `knowledge_bases`, `ai_token_usage` TẮT RLS trong khi `anon` có đủ quyền SELECT/INSERT/UPDATE/DELETE
-- — ai mở web lên cũng đọc được API key, tự duyệt mình vào bot Telegram, hay đổi địa chỉ cổng AI sang
-- máy của kẻ xấu để hứng toàn bộ câu hỏi kèm nội dung KB. Đã tái hiện được bằng curl trước khi vá.
--
-- AN TOÀN VỚI BACKEND: backend kết nối bằng role `postgres` (chủ sở hữu bảng, có BYPASSRLS), còn
-- frontend không truy vấn bảng trực tiếp (chỉ dùng Supabase Auth) — nên bật RLS không có policy nào
-- chính là "chặn toàn bộ truy cập từ ngoài", không ảnh hưởng đường chạy thật.
--
-- KHÔNG xoá/đổi dữ liệu nào: chỉ bật RLS và thu hồi quyền.

-- 1) Bật RLS + thu hồi quyền cho MỌI bảng trong `public` và trong schema của MỌI KB. Lấy danh sách
--    schema theo `knowledge_bases` chứ không liệt kê cứng kb_vi/kb_en, để phủ cả KB tạo từ giao diện.
--
--    Danh sách bảng được gom vào MẢNG trước rồi mới ALTER: nếu ALTER ngay trong vòng lặp đang đọc
--    `knowledge_bases`, Postgres từ chối ("being used by active queries in this session") vì chính
--    bảng đó cũng nằm trong danh sách cần ALTER.
DO $$
DECLARE
  kb_schemas text[];
  tables regclass[];
  t regclass;
BEGIN
  SELECT coalesce(array_agg(kb.schema_name), '{}') INTO kb_schemas FROM public.knowledge_bases kb;

  SELECT coalesce(array_agg(c.oid::regclass), '{}') INTO tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND (n.nspname = 'public' OR n.nspname = ANY (kb_schemas));

  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM anon, authenticated', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 2) Bảng/sequence tạo SAU NÀY trong `public` (qua migration, chạy bằng role postgres) không còn tự
--    được Supabase cấp quyền cho anon/authenticated nữa. Nếu thiếu bước này, bảng mới nào cũng lại
--    lộ ra REST API ngay khi vừa tạo.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
