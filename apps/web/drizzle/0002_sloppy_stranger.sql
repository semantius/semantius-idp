CREATE TABLE "idp"."gateway" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"require_auth" boolean DEFAULT false,
	"source" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "gateway_source_idx" ON "idp"."gateway" USING btree ("source");