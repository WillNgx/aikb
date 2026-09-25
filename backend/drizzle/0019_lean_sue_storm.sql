ALTER TABLE "kb_en"."promotions" ADD COLUMN IF NOT EXISTS "import_tag" text;--> statement-breakpoint
ALTER TABLE "kb_vi"."promotions" ADD COLUMN IF NOT EXISTS "import_tag" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_import_tag_idx" ON "kb_en"."promotions" USING btree ("import_tag");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_import_tag_idx" ON "kb_vi"."promotions" USING btree ("import_tag");--> statement-breakpoint
-- KB tạo từ giao diện không được khai báo trong db/schema.ts nên drizzle-kit bỏ sót chúng (xem
-- CLAUDE.md, mục "Thêm một KB mới"). Chạy vòng qua MỌI schema có trong bảng knowledge_bases để
-- không KB nào thiếu cột. Dùng IF NOT EXISTS nên 2 schema ở trên chạy lại cũng vô hại.
DO $$
DECLARE ten_schema text;
BEGIN
  FOR ten_schema IN SELECT schema_name FROM public.knowledge_bases LOOP
    EXECUTE format('ALTER TABLE %I.promotions ADD COLUMN IF NOT EXISTS import_tag text', ten_schema);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS promotions_import_tag_idx ON %I.promotions USING btree (import_tag)',
      ten_schema
    );
  END LOOP;
END $$;
