ALTER TABLE "webhook_events" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_usage_ref_created_at_idx" ON "ai_usage" USING btree ("created_at") WHERE "ai_usage"."ref" is not null;--> statement-breakpoint
CREATE INDEX "message_attachments_file_idx" ON "message_attachments" USING btree ("file_public_id") WHERE "message_attachments"."file_public_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_events_payload_received_at_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."payload" is not null;