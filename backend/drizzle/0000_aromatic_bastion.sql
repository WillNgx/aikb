CREATE TYPE "public"."analytics_event_type" AS ENUM('search', 'ai_question', 'ai_no_answer');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('content_create', 'content_edit', 'content_delete', 'content_publish', 'content_unpublish', 'user_create', 'user_edit', 'user_enable', 'user_disable');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'published', 'unpublished');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" "analytics_event_type" NOT NULL,
	"query" text,
	"content_id" uuid,
	"user_id" uuid,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "audit_action" NOT NULL,
	"actor_id" uuid,
	"actor_email" text,
	"target_id" uuid,
	"target_type" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"author_id" uuid NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"section_title" text,
	"chunk_text" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"embedding" vector(768),
	"search_vector" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content" ADD CONSTRAINT "content_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_saved_by_users_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_type_idx" ON "analytics_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_created_at_idx" ON "analytics_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_actor_id_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_content_id_idx" ON "content_chunks" USING btree ("content_id");