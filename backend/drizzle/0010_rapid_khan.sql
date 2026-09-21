ALTER TYPE "public"."audit_action" ADD VALUE 'promotion_import';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'promotion_provider_edit';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotion_versions" (
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
CREATE TABLE IF NOT EXISTS "promotions" (
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
DO $$ BEGIN
 ALTER TABLE "promotion_versions" ADD CONSTRAINT "promotion_versions_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promotions" ADD CONSTRAINT "promotions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_versions_promotion_id_idx" ON "promotion_versions" USING btree ("promotion_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_versions_promotion_hash_idx" ON "promotion_versions" USING btree ("promotion_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_start_month_idx" ON "promotions" USING btree ("start_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_category_idx" ON "promotions" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotions_provider_idx" ON "promotions" USING btree ("provider");