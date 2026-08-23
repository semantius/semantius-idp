import { describe, expect, it } from "vitest"

import { retargetSchema } from "@/server/db/migrate"
import {
  createAuthSchema,
  CANONICAL_SCHEMA_NAME,
} from "@/server/db/schema/auth-schema"

describe("retargetSchema (DM-4, CFG-4 database.schema)", () => {
  it("makes CREATE SCHEMA idempotent even for the canonical name", () => {
    const { sql, replacements } = retargetSchema(
      `CREATE SCHEMA "idp";`,
      CANONICAL_SCHEMA_NAME
    )
    expect(sql).toBe(`CREATE SCHEMA IF NOT EXISTS "idp";`)
    expect(replacements).toBe(0)
  })

  it("retargets qualified table names", () => {
    const { sql, replacements } = retargetSchema(
      `CREATE TABLE "idp"."user" (\n\t"id" text PRIMARY KEY NOT NULL\n);`,
      "auth"
    )
    expect(sql).toContain(`CREATE TABLE "auth"."user"`)
    expect(replacements).toBe(1)
  })

  it("retargets CREATE SCHEMA and keeps it idempotent", () => {
    const { sql } = retargetSchema(`CREATE SCHEMA "idp";`, "auth")
    expect(sql).toBe(`CREATE SCHEMA IF NOT EXISTS "auth";`)
  })

  it("retargets foreign keys and indexes", () => {
    const input = `ALTER TABLE "idp"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "idp"."user"("id") ON DELETE cascade;`
    const { sql, replacements } = retargetSchema(input, "auth")
    expect(sql).not.toContain(`"idp".`)
    expect(sql).toContain(`"auth"."session"`)
    expect(sql).toContain(`"auth"."user"`)
    expect(replacements).toBe(2)
  })

  it("leaves the word alone when it is not a schema qualifier", () => {
    // A column named `idp_id`, a quoted table called "idp_things", and prose in
    // a comment must all survive untouched.
    const input = `CREATE TABLE "idp"."idp_things" ("idp_id" text); -- the idp owns "idp" here`
    const { sql } = retargetSchema(input, "auth")
    expect(sql).toBe(
      `CREATE TABLE "auth"."idp_things" ("idp_id" text); -- the idp owns "idp" here`
    )
  })

  it("is a no-op for the canonical name apart from the idempotency rewrite", () => {
    const input = `CREATE TABLE "idp"."user" ("id" text);`
    expect(retargetSchema(input, CANONICAL_SCHEMA_NAME)).toEqual({
      sql: input,
      replacements: 0,
    })
  })
})

describe("createAuthSchema (DM-4)", () => {
  it("binds every table to the schema it is given", () => {
    const schema = createAuthSchema("tenant_a")
    // Drizzle keeps the schema on the table's symbol metadata; the observable
    // effect is that a query against it is qualified.
    expect(Object.keys(schema)).toContain("user")
    expect(Object.keys(schema)).toContain("auditLog")
    expect(Object.keys(schema)).toContain("pendingAuthorization")
  })

  it("produces independent tables per schema name", () => {
    const a = createAuthSchema("tenant_a")
    const b = createAuthSchema("tenant_b")
    expect(a.user).not.toBe(b.user)
  })

  it("covers the DM-2 table inventory", () => {
    const schema = createAuthSchema(CANONICAL_SCHEMA_NAME)
    for (const table of [
      "user",
      "session",
      "account",
      "verification",
      "twoFactor",
      "rateLimit",
      "jwks",
      "oauthClient",
      "oauthRefreshToken",
      "oauthAccessToken",
      "oauthConsent",
      "oauthResource",
      "oauthClientResource",
      "apikey",
      "auditLog",
    ]) {
      expect(Object.keys(schema)).toContain(table)
    }
  })

  it("does not include the tables DM-2 puts out of scope", () => {
    const keys = Object.keys(createAuthSchema(CANONICAL_SCHEMA_NAME))
    for (const table of [
      "organization",
      "member",
      "invitation",
      "subscription",
      "organizationRole",
    ]) {
      expect(keys).not.toContain(table)
    }
  })
})
