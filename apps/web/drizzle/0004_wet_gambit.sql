DROP INDEX "idp"."account_issuer_accountId_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "idp"."account" USING btree ("provider_id","account_id");--> statement-breakpoint
ALTER TABLE "idp"."account" DROP COLUMN "issuer";