CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buildings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"connector_type" text NOT NULL,
	"connector_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buildings_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "known_projects" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "known_projects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"building_id" uuid NOT NULL,
	"name" text NOT NULL,
	"workspace_path" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "persistent_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"building_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role_short" text DEFAULT '' NOT NULL,
	"role_full" text DEFAULT '' NOT NULL,
	"workspace_path" text DEFAULT '' NOT NULL,
	"team_id" text,
	"reports_to_id" text,
	"palette" integer,
	"hue_shift" integer,
	"seat_id" text,
	"current_session_id" text,
	"last_session_end" text,
	"session_count" integer,
	"current_ticket_id" text,
	"current_ticket_name" text,
	"current_ticket_url" text,
	"last_ticket_id" text,
	"retired" boolean
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"building_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "seats_building_id_session_id_pk" PRIMARY KEY("building_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "worker_assignments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "worker_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"building_id" uuid NOT NULL,
	"ticket_id" text NOT NULL,
	"ticket_name" text NOT NULL,
	"worker" text NOT NULL,
	"worker_host" text NOT NULL,
	"started_at" text NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "known_projects" ADD CONSTRAINT "known_projects_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persistent_agents" ADD CONSTRAINT "persistent_agents_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_assignments" ADD CONSTRAINT "worker_assignments_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "known_projects_building_workspace_idx" ON "known_projects" USING btree ("building_id","workspace_path");