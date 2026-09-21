CREATE TYPE "public"."node_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."node_type" AS ENUM('folder', 'article');--> statement-breakpoint
CREATE TYPE "public"."slang_target_type" AS ENUM('provider', 'bet_type', 'platform', 'category', 'general');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'slang_create';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'slang_edit';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'slang_delete';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'node_create';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'node_edit';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'node_delete';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'node_move';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'node_publish';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "node_type" NOT NULL,
	"parent_id" uuid,
	"status" "node_status" DEFAULT 'draft' NOT NULL,
	"body" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slang_dictionary" (
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
ALTER TABLE "content" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "sub_category" text;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "group_name" text;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "parent_code" text;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "sub_category" text;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "platform" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nodes" ADD CONSTRAINT "nodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "slang_dictionary" ADD CONSTRAINT "slang_dictionary_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nodes_parent_id_idx" ON "nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nodes_type_idx" ON "nodes" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nodes_status_idx" ON "nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slang_dictionary_term_idx" ON "slang_dictionary" USING btree ("slang_term");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slang_dictionary_type_idx" ON "slang_dictionary" USING btree ("target_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_category_idx" ON "content_chunks" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_provider_idx" ON "content_chunks" USING btree ("provider");