CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_color_check" CHECK ("groups"."color" in ('group-1', 'group-2', 'group-3', 'group-4', 'group-5', 'group-6', 'group-7', 'group-8'))
);
--> statement-breakpoint
UPDATE "pages" SET "group_id" = NULL WHERE "group_id" IS NOT NULL AND "group_id" NOT IN (SELECT "id" FROM "groups");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pages_group_idx" ON "pages" USING btree ("group_id") WHERE "pages"."group_id" is not null;