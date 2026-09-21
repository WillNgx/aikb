CREATE TYPE "public"."telegram_user_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'telegram_approve';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'telegram_reject';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'telegram_revoke';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'telegram_delete';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" text NOT NULL,
	"username" text,
	"display_name" text NOT NULL,
	"status" "telegram_user_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_users_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_users" ADD CONSTRAINT "telegram_users_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_users_telegram_id_idx" ON "telegram_users" USING btree ("telegram_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_users_status_idx" ON "telegram_users" USING btree ("status");