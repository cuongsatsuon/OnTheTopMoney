CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"text" text,
	"status" text NOT NULL,
	"token_count" integer,
	"error_code" text,
	"file_public_id" text,
	"file_resource_type" text,
	"file_format" text,
	"file_mime" text,
	"file_bytes" integer,
	"processed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_items_owner_type_check" CHECK ("knowledge_items"."owner_type" in ('group', 'page')),
	CONSTRAINT "knowledge_items_kind_check" CHECK ("knowledge_items"."kind" in ('faq', 'file')),
	CONSTRAINT "knowledge_items_status_check" CHECK ("knowledge_items"."status" in ('processing', 'ready', 'failed', 'too_large')),
	CONSTRAINT "knowledge_items_error_code_check" CHECK ("knowledge_items"."error_code" is null or "knowledge_items"."error_code" in ('UNREADABLE', 'NO_TEXT', 'PASSWORD_PROTECTED', 'EXTRACT_TIMEOUT', 'FILE_UNAVAILABLE', 'KNOWLEDGE_TOO_LARGE')),
	CONSTRAINT "knowledge_items_file_mime_check" CHECK ("knowledge_items"."file_mime" is null or "knowledge_items"."file_mime" in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'))
);
--> statement-breakpoint
CREATE INDEX "knowledge_items_owner_idx" ON "knowledge_items" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "knowledge_items_file_idx" ON "knowledge_items" USING btree ("file_public_id");