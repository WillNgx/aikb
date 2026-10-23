-- Ảnh theo chunk cho AI chat. Chỉ THÊM cột jsonb cho phép NULL: không đụng dữ liệu, không khoá
-- bảng lâu. Chunk cũ để NULL (không ảnh) cho tới khi bài được Đăng lại / re-index từng bài.
ALTER TABLE "kb_vi"."content_chunks" ADD COLUMN IF NOT EXISTS "images" jsonb;--> statement-breakpoint
ALTER TABLE "kb_en"."content_chunks" ADD COLUMN IF NOT EXISTS "images" jsonb;--> statement-breakpoint
-- KB tạo từ giao diện không khai báo trong db/schema.ts nên drizzle-kit bỏ sót: lặp qua MỌI
-- schema trong knowledge_bases (IF NOT EXISTS nên 2 schema trên chạy lại vô hại).
DO $$
DECLARE ten_schema text;
BEGIN
  FOR ten_schema IN SELECT schema_name FROM public.knowledge_bases LOOP
    EXECUTE format('ALTER TABLE %I.content_chunks ADD COLUMN IF NOT EXISTS images jsonb', ten_schema);
  END LOOP;
END $$;
