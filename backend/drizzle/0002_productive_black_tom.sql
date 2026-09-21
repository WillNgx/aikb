ALTER TABLE "content_chunks" ALTER COLUMN "content_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "node_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_node_id_idx" ON "content_chunks" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_fts_idx" ON "content_chunks" USING gin (to_tsvector('simple', "chunk_text"));