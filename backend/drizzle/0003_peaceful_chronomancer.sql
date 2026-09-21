ALTER TABLE "nodes" ADD COLUMN "has_been_saved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "published_name" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "published_body" jsonb;--> statement-breakpoint
-- Defensive cleanup: nodes.parent_id never had a real FK constraint before this migration,
-- so any row whose parent_id points at a deleted/missing node would silently break the
-- ADD CONSTRAINT below. Re-parent any such orphan to root instead of failing the migration.
UPDATE "nodes" SET "parent_id" = NULL
WHERE "parent_id" IS NOT NULL AND "parent_id" NOT IN (SELECT "id" FROM "nodes");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
