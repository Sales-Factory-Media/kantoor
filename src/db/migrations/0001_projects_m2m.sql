-- Replace building-scoped `known_projects` with a global `projects` pool
-- plus a `building_projects` join table. A project can now belong to multiple
-- buildings; removing a building-project link doesn't remove the project itself.

CREATE TABLE "projects" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "projects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"workspace_path" text NOT NULL,
	"description" text,
	CONSTRAINT "projects_workspace_path_unique" UNIQUE("workspace_path")
);
--> statement-breakpoint

CREATE TABLE "building_projects" (
	"building_id" uuid NOT NULL,
	"project_id" integer NOT NULL,
	CONSTRAINT "building_projects_building_id_project_id_pk" PRIMARY KEY("building_id","project_id")
);
--> statement-breakpoint

ALTER TABLE "building_projects" ADD CONSTRAINT "building_projects_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "building_projects" ADD CONSTRAINT "building_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Backfill: dedupe `known_projects` by workspace_path into the global pool,
-- then create memberships for every (building_id, workspace_path) that
-- existed in known_projects.
INSERT INTO "projects" ("name", "workspace_path", "description")
SELECT DISTINCT ON ("workspace_path") "name", "workspace_path", "description"
FROM "known_projects"
ORDER BY "workspace_path", "id";--> statement-breakpoint

INSERT INTO "building_projects" ("building_id", "project_id")
SELECT DISTINCT kp."building_id", p."id"
FROM "known_projects" kp
JOIN "projects" p ON p."workspace_path" = kp."workspace_path";--> statement-breakpoint

DROP TABLE "known_projects";
