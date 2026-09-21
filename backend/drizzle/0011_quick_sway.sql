CREATE TABLE IF NOT EXISTS "kb_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_bases" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"locale" text NOT NULL,
	"schema_name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "ai_token_usage_date_provider_model_idx";--> statement-breakpoint
ALTER TABLE "ai_token_usage" ADD COLUMN "kb_code" text DEFAULT 'kb_vi' NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN "kb_code" text DEFAULT 'kb_vi' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "kb_code" text DEFAULT 'kb_vi' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_users" ADD COLUMN "kb_code" text DEFAULT 'kb_vi' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_kb" text DEFAULT 'kb_vi' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_token_usage_date_kb_provider_model_idx" ON "ai_token_usage" USING btree ("usage_date","kb_code","provider","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_kb_code_idx" ON "analytics_events" USING btree ("kb_code");--> statement-breakpoint
-- Nạp sẵn KB tiếng Việt đang chạy. `schema_name = 'public'` là CỐ Ý: dữ liệu vẫn nằm nguyên
-- chỗ cũ, việc chuyển sang schema `kb_vi` là một migration riêng chạy sau, đảo ngược được.
INSERT INTO "knowledge_bases" ("code", "name", "locale", "schema_name", "sort_order")
VALUES ('kb_vi', 'Tiếng Việt', 'vi', 'public', 0)
ON CONFLICT ("code") DO NOTHING;
