CREATE TABLE IF NOT EXISTS "ai_token_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usage_date" date NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_token_usage_date_provider_model_idx" ON "ai_token_usage" USING btree ("usage_date","provider","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_token_usage_date_idx" ON "ai_token_usage" USING btree ("usage_date");