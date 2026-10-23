CREATE TABLE "contact_identities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"contact_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"platform_user_id" text NOT NULL,
	"display_name" text,
	"username" text,
	"profile_fetched_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_identities_page_user_unique" UNIQUE("page_id","platform_user_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text,
	"stage" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_stage_check" CHECK ("contacts"."stage" in ('new', 'consulting', 'ordered', 'loyal', 'complaint'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"page_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"thread_key" text NOT NULL,
	"contact_identity_id" uuid NOT NULL,
	"state" text DEFAULT 'triage' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"state_reason" text,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"waiting_since" timestamp (3) with time zone,
	"last_customer_message_at" timestamp (3) with time zone,
	"last_message_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_thread_unique" UNIQUE("page_id","channel","thread_key"),
	CONSTRAINT "conversations_channel_check" CHECK ("conversations"."channel" in ('dm', 'comment')),
	CONSTRAINT "conversations_state_check" CHECK ("conversations"."state" in ('triage', 'ai', 'handoff', 'human', 'done')),
	CONSTRAINT "conversations_state_reason_check" CHECK ("conversations"."state_reason" in ('AI_OFF', 'CHANNEL_OFF', 'CONFIG_MISSING', 'OUTSIDE_HOURS', 'OPENAI_KEY_UNAVAILABLE', 'AI_BUDGET_EXCEEDED', 'AI_PROVIDER_ERROR', 'KEYWORD', 'CUSTOMER_ASKED_HUMAN', 'AI_UNCERTAIN', 'AI_POLICY_BLOCKED', 'NON_TEXT_MESSAGE', 'OUTSIDE_24H', 'HUMAN_REPLIED', 'TAKEOVER', 'AI_REENABLED', 'MARKED_DONE', 'GATE_OPEN'))
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_url" text,
	"file_public_id" text,
	"file_resource_type" text,
	"file_format" text,
	"mime" text,
	"bytes" bigint,
	"error_code" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_position_unique" UNIQUE("message_id","position"),
	CONSTRAINT "message_attachments_kind_check" CHECK ("message_attachments"."kind" in ('image', 'audio', 'video', 'file')),
	CONSTRAINT "message_attachments_status_check" CHECK ("message_attachments"."status" in ('pending', 'stored', 'failed')),
	CONSTRAINT "message_attachments_error_check" CHECK ("message_attachments"."error_code" in ('MEDIA_NOT_CONFIGURED', 'UNSUPPORTED_TYPE', 'TOO_LARGE', 'INVALID_URL', 'FETCH_FAILED')),
	CONSTRAINT "message_attachments_resource_type_check" CHECK ("message_attachments"."file_resource_type" in ('image', 'raw'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"platform_message_id" text,
	"direction" text,
	"origin" text NOT NULL,
	"status" text,
	"text" text,
	"reason_code" text,
	"platform_timestamp" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_system_direction_check" CHECK (("messages"."origin" = 'system') = ("messages"."direction" is null)),
	CONSTRAINT "messages_origin_check" CHECK ("messages"."origin" in ('customer', 'app_human', 'app_ai', 'app_unmatched', 'external_human', 'system')),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" in ('pending', 'sending', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "messages_reason_code_check" CHECK ("messages"."reason_code" in ('AI_OFF', 'CHANNEL_OFF', 'CONFIG_MISSING', 'OUTSIDE_HOURS', 'OPENAI_KEY_UNAVAILABLE', 'AI_BUDGET_EXCEEDED', 'AI_PROVIDER_ERROR', 'KEYWORD', 'CUSTOMER_ASKED_HUMAN', 'AI_UNCERTAIN', 'AI_POLICY_BLOCKED', 'NON_TEXT_MESSAGE', 'OUTSIDE_24H', 'HUMAN_REPLIED', 'TAKEOVER', 'AI_REENABLED', 'MARKED_DONE', 'GATE_OPEN'))
);
--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_identity_id_contact_identities_id_fk" FOREIGN KEY ("contact_identity_id") REFERENCES "public"."contact_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_identities_contact_idx" ON "contact_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversations_last_message_idx" ON "conversations" USING btree ("last_message_at","id");--> statement-breakpoint
CREATE INDEX "conversations_identity_idx" ON "conversations" USING btree ("contact_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_page_platform_id_unique" ON "messages" USING btree ("page_id","platform_message_id") WHERE "messages"."platform_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_ts_idx" ON "messages" USING btree ("conversation_id","platform_timestamp","id");