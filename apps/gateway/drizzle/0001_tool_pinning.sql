ALTER TYPE "public"."audit_outcome" ADD VALUE 'pending_review';--> statement-breakpoint
ALTER TABLE "upstream_servers" ADD COLUMN "tools_pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD COLUMN "approved_definition" jsonb;--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD COLUMN "approved_hash" text;--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "upstream_tools" ADD CONSTRAINT "upstream_tools_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;