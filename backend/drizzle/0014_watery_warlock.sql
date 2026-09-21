-- Tạo schema cho KB tiếng Anh.
--
-- ⚠️ Dòng CREATE SCHEMA này được THÊM TAY. drizzle-kit chỉ tự sinh nó khi đối tượng pgSchema
-- được export ở cấp cao nhất; ở đây schema được tạo bên trong factory makeKbTables() nên
-- drizzle-kit chỉ thấy các BẢNG mà không thấy schema, và migration sẽ chết ở câu CREATE TABLE
-- đầu tiên vì schema chưa tồn tại. Thêm KB mới thì nhớ kiểm tra lại dòng này.
CREATE SCHEMA IF NOT EXISTS "kb_en";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_en"."content_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"section_title" text,
	"heading_index" integer,
	"chunk_text" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"embedding" vector(768),
	"search_vector" text,
	"category" text,
	"sub_category" text,
	"provider" text,
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_en"."kb_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_en"."nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "node_type" NOT NULL,
	"parent_id" uuid,
	"status" "node_status" DEFAULT 'draft' NOT NULL,
	"body" jsonb,
	"has_been_saved" boolean DEFAULT false NOT NULL,
	"published_name" text,
	"published_body" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_provider" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_en"."promotion_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promotion_id" uuid NOT NULL,
	"version_label" text NOT NULL,
	"start_date" date,
	"time_text" text,
	"summary" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_file" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_en"."promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_key" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"provider" text,
	"provider_locked" boolean DEFAULT false NOT NULL,
	"start_month" text NOT NULL,
	"node_id" uuid,
	"latest_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_title_key_unique" UNIQUE("title_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_en"."slang_dictionary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slang_term" text NOT NULL,
	"normalized_entity" text NOT NULL,
	"target_type" "slang_target_type" DEFAULT 'general' NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_en"."content_chunks" ADD CONSTRAINT "content_chunks_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "kb_en"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_en"."nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "kb_en"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_en"."nodes" ADD CONSTRAINT "nodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_en"."promotion_versions" ADD CONSTRAINT "promotion_versions_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "kb_en"."promotions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_en"."promotions" ADD CONSTRAINT "promotions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "kb_en"."nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kb_en"."slang_dictionary" ADD CONSTRAINT "slang_dictionary_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_node_id_idx" ON "kb_en"."content_chunks" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_category_idx" ON "kb_en"."content_chunks" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_provider_idx" ON "kb_en"."content_chunks" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_fts_idx" ON "kb_en"."content_chunks" USING gin (to_tsvector('simple', "chunk_text"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nodes_parent_id_idx" ON "kb_en"."nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nodes_type_idx" ON "kb_en"."nodes" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nodes_status_idx" ON "kb_en"."nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_versions_promotion_id_idx" ON "kb_en"."promotion_versions" USING btree ("promotion_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_versions_promotion_hash_idx" ON "kb_en"."promotion_versions" USING btree ("promotion_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_start_month_idx" ON "kb_en"."promotions" USING btree ("start_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_category_idx" ON "kb_en"."promotions" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_provider_idx" ON "kb_en"."promotions" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slang_dictionary_term_idx" ON "kb_en"."slang_dictionary" USING btree ("slang_term");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slang_dictionary_type_idx" ON "kb_en"."slang_dictionary" USING btree ("target_type");