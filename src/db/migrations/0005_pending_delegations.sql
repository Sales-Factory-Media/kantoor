-- Persist Auto Mode delegations (Darryl's classifications awaiting a human
-- Start/Discard/Postpone). Previously in-memory only, so pending recommendations
-- were lost on every hub restart. `last_evaluated_at` + `ticket_updated_at` let
-- auto-pickup re-classify a ticket that was edited after Darryl looked at it.
CREATE TABLE IF NOT EXISTS "pending_delegations" (
	"ticket_id" text PRIMARY KEY NOT NULL,
	"building_id" uuid REFERENCES "buildings"("id") ON DELETE CASCADE,
	"ticket_name" text NOT NULL DEFAULT '',
	"ticket_url" text NOT NULL DEFAULT '',
	"recommended_agent_id" text NOT NULL,
	"recommended_agent_name" text NOT NULL DEFAULT '',
	"recommended_agent_role" text NOT NULL DEFAULT '',
	"recommended_workspace_path" text NOT NULL DEFAULT '',
	"reasoning" text NOT NULL DEFAULT '',
	"brief" text NOT NULL DEFAULT '',
	"created_at" bigint NOT NULL,
	"last_evaluated_at" bigint NOT NULL,
	"ticket_updated_at" bigint,
	"postponed_until" bigint
);
