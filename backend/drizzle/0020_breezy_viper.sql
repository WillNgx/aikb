ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'promotion_codes_edit' BEFORE 'kb_create';--> statement-breakpoint
ALTER TABLE "kb_en"."promotions" ADD COLUMN IF NOT EXISTS "code" text;--> statement-breakpoint
ALTER TABLE "kb_en"."promotions" ADD COLUMN IF NOT EXISTS "code_name" text;--> statement-breakpoint
ALTER TABLE "kb_vi"."promotions" ADD COLUMN IF NOT EXISTS "code" text;--> statement-breakpoint
ALTER TABLE "kb_vi"."promotions" ADD COLUMN IF NOT EXISTS "code_name" text;--> statement-breakpoint
-- KB tạo từ giao diện không được khai báo trong db/schema.ts nên drizzle-kit bỏ sót chúng. Chạy
-- vòng qua MỌI schema trong knowledge_bases để không KB nào thiếu cột (IF NOT EXISTS nên 2 schema
-- ở trên chạy lại cũng vô hại).
DO $$
DECLARE ten_schema text;
BEGIN
  FOR ten_schema IN SELECT schema_name FROM public.knowledge_bases LOOP
    EXECUTE format('ALTER TABLE %I.promotions ADD COLUMN IF NOT EXISTS code text', ten_schema);
    EXECUTE format('ALTER TABLE %I.promotions ADD COLUMN IF NOT EXISTS code_name text', ten_schema);
  END LOOP;
END $$;
