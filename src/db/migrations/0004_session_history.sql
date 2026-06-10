-- Durable session → agent ownership. Survives transient ps-aux failures /
-- aggressive prune of `persistent_agents.current_sessions`, so onNewSession can
-- always resolve a session to its original employee instead of minting a new
-- provisional duplicate.
CREATE TABLE IF NOT EXISTS "session_history" (
	"session_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL REFERENCES "persistent_agents"("id") ON DELETE CASCADE,
	"building_id" uuid NOT NULL REFERENCES "buildings"("id") ON DELETE CASCADE,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_history_agent_idx" ON "session_history" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_history_building_idx" ON "session_history" ("building_id");
--> statement-breakpoint
-- Backfill from existing `current_sessions` arrays so the table reflects what
-- the system already considers attached. Sessions already pruned (last session
-- end set, current_sessions cleared) cannot be recovered — those are the
-- duplicates the cleanup script collapses.
INSERT INTO "session_history" ("session_id", "agent_id", "building_id")
SELECT
	s.session_id::text,
	pa.id,
	pa.building_id
FROM "persistent_agents" pa
CROSS JOIN LATERAL (
	SELECT (value->>'sessionId') AS session_id
	FROM jsonb_array_elements(COALESCE(pa.current_sessions, '[]'::jsonb)) AS t(value)
) s
WHERE s.session_id IS NOT NULL AND s.session_id <> ''
ON CONFLICT ("session_id") DO NOTHING;
