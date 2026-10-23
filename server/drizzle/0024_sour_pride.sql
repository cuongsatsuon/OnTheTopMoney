CREATE TABLE "autoreply_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"last_inbound_id" uuid NOT NULL,
	"state_version" integer NOT NULL,
	"inbound_at" timestamp (3) with time zone NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"outcome" text,
	"reason_code" text,
	"config_source_type" text,
	"config_source_id" uuid,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"confidence" real,
	"message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "autoreply_runs_outcome_check" CHECK ("autoreply_runs"."outcome" in ('replied', 'handoff', 'not_applicable', 'superseded', 'failed')),
	CONSTRAINT "autoreply_runs_reason_check" CHECK ("autoreply_runs"."reason_code" in ('AI_OFF', 'CHANNEL_OFF', 'CONFIG_MISSING', 'OUTSIDE_HOURS', 'OPENAI_KEY_UNAVAILABLE', 'AI_BUDGET_EXCEEDED', 'AI_PROVIDER_ERROR', 'KEYWORD', 'CUSTOMER_ASKED_HUMAN', 'AI_UNCERTAIN', 'AI_POLICY_BLOCKED', 'NON_TEXT_MESSAGE', 'OUTSIDE_24H')),
	CONSTRAINT "autoreply_runs_source_check" CHECK ("autoreply_runs"."config_source_type" in ('group', 'page'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_typing_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "autoreply_runs_conversation_idx" ON "autoreply_runs" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "autoreply_runs_started_idx" ON "autoreply_runs" USING btree ("started_at");