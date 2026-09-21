CREATE TABLE IF NOT EXISTS "custom_ai_gateways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text NOT NULL,
	"default_model" text NOT NULL,
	"suggested_models" text[],
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_ai_gateways_is_active_idx" ON "custom_ai_gateways" USING btree ("is_active");
