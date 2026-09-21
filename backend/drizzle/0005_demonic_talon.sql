ALTER TABLE "content" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "content" CASCADE;--> statement-breakpoint
DROP TABLE "content_versions" CASCADE;--> statement-breakpoint
ALTER TABLE "analytics_events" DROP CONSTRAINT IF EXISTS "analytics_events_content_id_content_id_fk";
--> statement-breakpoint
ALTER TABLE "content_chunks" DROP CONSTRAINT IF EXISTS "content_chunks_content_id_content_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "content_chunks_content_id_idx";--> statement-breakpoint
ALTER TABLE "analytics_events" DROP COLUMN IF EXISTS "content_id";--> statement-breakpoint
ALTER TABLE "content_chunks" DROP COLUMN IF EXISTS "content_id";--> statement-breakpoint
DROP TYPE "public"."content_status";