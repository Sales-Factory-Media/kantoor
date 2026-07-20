-- Optional per-project logo, stored inline as a data URI. Rendered in front of
-- the project name in the employees sidebar and on agent cards.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "logo" text;
