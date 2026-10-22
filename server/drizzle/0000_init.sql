CREATE TABLE "worker_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"hostname" text NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL
);
