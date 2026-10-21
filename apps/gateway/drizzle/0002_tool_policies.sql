CREATE TYPE "public"."policy_effect" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."policy_scope" AS ENUM('all', 'writes');--> statement-breakpoint
CREATE TYPE "public"."policy_subject" AS ENUM('role', 'user');--> statement-breakpoint
CREATE TABLE "tool_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "policy_subject" NOT NULL,
	"role" "user_role",
	"user_id" uuid,
	"server_slug" text DEFAULT '*' NOT NULL,
	"tool_pattern" text DEFAULT '*' NOT NULL,
	"scope" "policy_scope" DEFAULT 'all' NOT NULL,
	"effect" "policy_effect" NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_policies_user_idx" ON "tool_policies" USING btree ("user_id");