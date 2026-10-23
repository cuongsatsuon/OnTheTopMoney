ALTER TABLE "conversations" ADD COLUMN "platform_post_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "post_text_snapshot" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "post_text_fetched_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "edited_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "removal" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "removed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_identity_id_contact_identities_id_fk" FOREIGN KEY ("sender_identity_id") REFERENCES "public"."contact_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_post_check" CHECK (("conversations"."channel" = 'comment') = ("conversations"."platform_post_id" is not null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_removal_check" CHECK ("messages"."removal" in ('deleted', 'hidden'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_removed_at_check" CHECK (("messages"."removal" is null) = ("messages"."removed_at" is null));