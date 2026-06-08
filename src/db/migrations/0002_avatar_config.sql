-- Per-employee DiceBear pixel-art avatar "combo", stored as a JSON string
-- ({ seed, options? }). Null until the user picks a face in the identify popup
-- or employee file.
ALTER TABLE "persistent_agents" ADD COLUMN "avatar_config" text;
