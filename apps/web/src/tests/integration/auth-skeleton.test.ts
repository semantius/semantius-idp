import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import { authRequest, createTestContext } from "./harness"
import type { TestContext } from "./harness"

/**
 * M3's exit criterion: a fresh database migrates wholly into its own schema and
 * a raw sign-up/sign-in round-trips through the real Better Auth instance
 * against real Postgres.
 *
 * Sign-up is enabled and approval switched off here so this file tests the
 * plumbing only; the approval gate itself is FR-SIGNUP-2's own suite.
 */
describe("Better Auth skeleton against Postgres", () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await createTestContext("auth-skeleton", {
      config: { signUp: { enabled: true, requireApproval: false } },
    })
  }, 120_000)

  afterAll(async () => {
    await ctx.teardown()
  })

  it("migrates every table into the file's own schema (DM-4)", async () => {
    const rows = await ctx.database.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = ${ctx.schemaName} and table_type = 'BASE TABLE'
    `
    const tables = rows.map((row) => row.table_name)
    expect(tables).toContain("user")
    expect(tables).toContain("oauth_client")
    expect(tables).toContain("audit_log")
    expect(tables).toContain("__drizzle_migrations")

    const publicTables = await ctx.database.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name = 'user'
    `
    expect(publicTables).toHaveLength(0)
  })

  it("signs a user up and signs them back in", async () => {
    const email = `skeleton-${Date.now()}@example.com`

    const signUp = await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: {
          email,
          password: "correct horse battery staple",
          name: "Sky Fisher",
        },
      })
    )
    expect(signUp.status).toBe(200)

    const signIn = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email, password: "correct horse battery staple" },
      })
    )
    expect(signIn.status).toBe(200)

    const wrongPassword = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email, password: "not the password" },
      })
    )
    expect(wrongPassword.status).toBeGreaterThanOrEqual(400)
  })

  it("persists the DM-3 custom columns with their declared defaults", async () => {
    const email = `columns-${Date.now()}@example.com`
    await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: {
          email,
          password: "correct horse battery staple",
          name: "Ari Vance",
        },
      })
    )

    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.email, email))

    expect(row).toBeDefined()
    expect(row!.status).toBe("active") // requireApproval is off in this file
    expect(row!.mustChangePassword).toBe(false)
    expect(row!.approvedAt).toBeNull()
    // FR-ROLE-1: the catalog's `default: true` role.
    expect(row!.role).toBe("user")
  })

  describe("FR-AUTH-7 mass assignment", () => {
    // The AC allows the privileged fields to be "ignored or rejected", and
    // Better Auth does both depending on the field — so the assertion is on the
    // *effect*: whatever the response code, no privilege may be granted.
    it.each([
      ["role", "admin"],
      ["status", "active"],
      ["banned", true],
      ["emailVerified", true],
      ["mustChangePassword", true],
      ["approvedBy", "self"],
      ["approvedAt", new Date(0).toISOString()],
    ])("never honors %s in a sign-up body", async (field, value) => {
      const email = `massassign-${field.toLowerCase()}-${Date.now()}@example.com`
      const response = await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: {
            email,
            password: "correct horse battery staple",
            name: "Mallory",
            [field]: value,
          },
        })
      )

      const [row] = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(eq(ctx.database.schema.user.email, email))

      if (response.status === 400) {
        // Rejected outright — the stronger outcome; no row at all.
        expect(await response.json()).toMatchObject({
          code: "FIELD_NOT_ALLOWED",
        })
        expect(row).toBeUndefined()
        return
      }

      // Accepted, so the field must have been ignored.
      expect(response.status).toBe(200)
      expect(row).toBeDefined()
      expect(row!.role).toBe("user")
      expect(row!.status).toBe("active") // from config, not from the body
      expect(row!.banned).not.toBe(true)
      expect(row!.emailVerified).toBe(false)
      expect(row!.mustChangePassword).toBe(false)
      expect(row!.approvedBy).toBeNull()
      expect(row!.approvedAt).toBeNull()
    })

    it("accepts the same sign-up once the privileged fields are gone", async () => {
      const email = `massassign-clean-${Date.now()}@example.com`
      const response = await ctx.auth.handler(
        authRequest("/sign-up/email", {
          json: {
            email,
            password: "correct horse battery staple",
            name: "Mallory",
          },
        })
      )
      expect(response.status).toBe(200)

      const [row] = await ctx.database.db
        .select()
        .from(ctx.database.schema.user)
        .where(eq(ctx.database.schema.user.email, email))
      expect(row!.role).toBe("user")
      expect(row!.banned).not.toBe(true)
      expect(row!.emailVerified).toBe(false)
      expect(row!.approvedBy).toBeNull()
    })
  })

  it("normalizes the e-mail address (FR-AUTH-1)", async () => {
    const stamp = Date.now()
    const response = await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: {
          email: `  MixedCase-${stamp}@Example.COM  `,
          password: "correct horse battery staple",
          name: "Case Insensitive",
        },
      })
    )
    expect(response.status).toBe(200)

    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(
        eq(ctx.database.schema.user.email, `mixedcase-${stamp}@example.com`)
      )
    expect(row).toBeDefined()
  })
})
