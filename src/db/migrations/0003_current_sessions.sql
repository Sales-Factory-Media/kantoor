-- Multi-session support: an agent can run N concurrent sessions (one per
-- iTerm tab / task). `current_sessions` is the authoritative list; the scalar
-- `current_session_id` + `current_ticket_*` columns are kept as a mirror of the
-- primary (first) session so existing "is online / busy" readers keep working.
ALTER TABLE "persistent_agents" ADD COLUMN "current_sessions" jsonb;
--> statement-breakpoint
UPDATE "persistent_agents"
SET "current_sessions" = jsonb_build_array(
	jsonb_strip_nulls(jsonb_build_object(
		'sessionId', "current_session_id",
		'ticketId', "current_ticket_id",
		'ticketName', "current_ticket_name",
		'ticketUrl', "current_ticket_url"
	))
)
WHERE "current_session_id" IS NOT NULL;
