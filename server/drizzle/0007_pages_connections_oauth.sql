CREATE TABLE "meta_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"fb_user_id" text NOT NULL,
	"name" text,
	"user_token" text NOT NULL,
	"expires_at" bigint DEFAULT 0 NOT NULL,
	"data_access_expires_at" bigint,
	"granular_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_accounts_fb_user_id_unique" UNIQUE("fb_user_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_results" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"session_id" uuid NOT NULL,
	"return_to" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"meta_account_id" uuid,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "oauth_results_status_check" CHECK ("oauth_results"."status" in ('ok', 'error'))
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"session_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"return_to" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "oauth_states_provider_check" CHECK ("oauth_states"."provider" in ('facebook')),
	CONSTRAINT "oauth_states_return_to_check" CHECK ("oauth_states"."return_to" in ('pages', 'welcome'))
);
--> statement-breakpoint
CREATE TABLE "page_credentials" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"meta_account_id" uuid,
	"access_token" text,
	"token_source_page_id" uuid,
	"expires_at" bigint DEFAULT 0 NOT NULL,
	"data_access_expires_at" bigint,
	"granular_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_credentials_token_source_check" CHECK (("page_credentials"."access_token" is null) <> ("page_credentials"."token_source_page_id" is null))
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"platform" text NOT NULL,
	"platform_account_id" text NOT NULL,
	"name" text NOT NULL,
	"handle" text,
	"avatar_url" text,
	"group_id" uuid,
	"connection_status" text DEFAULT 'active' NOT NULL,
	"connection_status_reason" text,
	"connected_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_platform_account_unique" UNIQUE("platform","platform_account_id"),
	CONSTRAINT "pages_platform_check" CHECK ("pages"."platform" in ('facebook', 'instagram', 'threads')),
	CONSTRAINT "pages_connection_status_check" CHECK ("pages"."connection_status" in ('active', 'expiring', 'disconnected'))
);
--> statement-breakpoint
CREATE INDEX "oauth_results_expires_at_idx" ON "oauth_results" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "page_credentials_token_source_idx" ON "page_credentials" USING btree ("token_source_page_id");--> statement-breakpoint
CREATE INDEX "pages_active_idx" ON "pages" USING btree ("connected_at") WHERE "pages"."removed_at" is null;