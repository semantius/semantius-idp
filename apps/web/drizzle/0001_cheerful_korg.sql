ALTER TABLE "idp"."account" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "idp"."audit_log" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "idp"."oauth_access_token" ALTER COLUMN "token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "idp"."oauth_access_token" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "idp"."oauth_access_token" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "idp"."oauth_consent" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "idp"."oauth_consent" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "idp"."oauth_refresh_token" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "idp"."oauth_refresh_token" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "idp"."pending_authorization" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "idp"."session" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "idp"."user" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "idp"."user" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "idp"."verification" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "idp"."verification" ALTER COLUMN "updated_at" SET DEFAULT now();