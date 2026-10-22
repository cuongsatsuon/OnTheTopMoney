ALTER TABLE "oauth_states" DROP CONSTRAINT "oauth_states_provider_check";--> statement-breakpoint
ALTER TABLE "oauth_results" ADD CONSTRAINT "oauth_results_provider_check" CHECK ("oauth_results"."provider" in ('facebook', 'threads'));--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_provider_check" CHECK ("oauth_states"."provider" in ('facebook', 'threads'));