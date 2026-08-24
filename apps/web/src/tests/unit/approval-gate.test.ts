import { describe, expect, it } from "vitest"

import {
  GATE_ERROR_CODES,
  assertUserMaySignIn,
  buildDatabaseHooks,
} from "@/server/auth/options/database-hooks"
import type { DbHandle } from "@/server/db/client"
import type { Mailer } from "@/server/email/mailer"
import type { Logger } from "@/server/logger"
import { idpPlugin } from "@/server/auth/plugins/idp-plugin"
import { deriveConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import { baseConfig } from "@/tests/fixtures/config-files"

/**
 * The status gate, as a decision rather than as a database walk.
 *
 * `approval-gate.test.ts` in the integration suite proves no session is
 * created for a non-`active` user on the password path. This is the same rule
 * viewed from underneath: the refusal itself, including the ban-expiry
 * arithmetic (FR-ADMIN-4), which a live test can only exercise by backdating
 * rows.
 */
function codeOf(run: () => void): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { body?: { code?: string } }).body?.code
  }
}

describe("assertUserMaySignIn (FR-SIGNUP-2, FR-ADMIN-4)", () => {
  it("lets an active, unbanned user through", () => {
    expect(codeOf(() => assertUserMaySignIn({ status: "active" }))).toBeUndefined()
  })

  it("refuses a row with no status at all", () => {
    // A user row that somehow carries no status must not read as "fine" —
    // the absence defaults to `pending`, which is the safe direction.
    expect(codeOf(() => assertUserMaySignIn({}))).toBe(
      GATE_ERROR_CODES.pendingApproval
    )
  })

  it("refuses each non-active status with its own code", () => {
    expect(codeOf(() => assertUserMaySignIn({ status: "pending" }))).toBe(
      GATE_ERROR_CODES.pendingApproval
    )
    expect(codeOf(() => assertUserMaySignIn({ status: "rejected" }))).toBe(
      GATE_ERROR_CODES.rejected
    )
  })

  it("treats a ban with no expiry as permanent", () => {
    expect(
      codeOf(() => assertUserMaySignIn({ status: "active", banned: true }))
    ).toBe(GATE_ERROR_CODES.banned)
    expect(
      codeOf(() =>
        assertUserMaySignIn({ status: "active", banned: true, banExpires: null })
      )
    ).toBe(GATE_ERROR_CODES.banned)
  })

  it("holds a ban until its expiry and lets go after", () => {
    const future = new Date(Date.now() + 60_000)
    const past = new Date(Date.now() - 60_000)
    expect(
      codeOf(() =>
        assertUserMaySignIn({
          status: "active",
          banned: true,
          banExpires: future,
        })
      )
    ).toBe(GATE_ERROR_CODES.banned)
    // FR-ADMIN-4: a lapsed ban restores access without an admin touching it.
    expect(
      codeOf(() =>
        assertUserMaySignIn({ status: "active", banned: true, banExpires: past })
      )
    ).toBeUndefined()
  })

  it("accepts the expiry as a string, which is how a driver may hand it over", () => {
    expect(
      codeOf(() =>
        assertUserMaySignIn({
          status: "active",
          banned: true,
          banExpires: new Date(Date.now() - 60_000).toISOString(),
        })
      )
    ).toBeUndefined()
  })

  it("keeps a ban rather than trusting an unparseable expiry", () => {
    // A date the driver could not parse must not read as "ban over".
    expect(
      codeOf(() =>
        assertUserMaySignIn({
          status: "active",
          banned: true,
          banExpires: "not a date",
        })
      )
    ).toBe(GATE_ERROR_CODES.banned)
  })
})

describe("the local plugin's audit_log table (SEC-6, DM-1)", () => {
  const config = deriveConfig(
    configFileSchema.parse(baseConfig()),
    [],
    BUILT_IN_ROLES
  )
  const schema = idpPlugin({ config }).schema as Record<
    string,
    { fields: Record<string, { required?: boolean; defaultValue?: unknown }> }
  >

  it("declares the table the generator emits", () => {
    // DM-1: the custom table is the schema of a local Better Auth plugin, so
    // one generator pass covers it along with everything else.
    expect(Object.keys(schema)).toContain("auditLog")
  })

  it("gives createdAt a default that produces a Date", () => {
    // The generator now *evaluates* this thunk to decide whether to emit
    // `.defaultNow()`, rather than matching its source text — 1.7.1 stringifies
    // `() => new Date` without parentheses, so the old test never matched
    // (D29). If this stops returning a Date the column silently loses its
    // default.
    const createdAt = schema.auditLog!.fields.createdAt!
    expect(typeof createdAt.defaultValue).toBe("function")
    expect((createdAt.defaultValue as () => unknown)()).toBeInstanceOf(Date)
  })

  it("requires the fields an event cannot be read without", () => {
    for (const field of ["action", "outcome", "createdAt"]) {
      expect(schema.auditLog!.fields[field]!.required).toBe(true)
    }
    // And leaves optional the ones a system or anonymous event has no value
    // for (SEC-7: a failed sign-in names nobody).
    for (const field of ["actorUserId", "actorType", "ipAddress"]) {
      expect(schema.auditLog!.fields[field]!.required).toBe(false)
    }
  })
})

describe("the pending-sign-up notification never breaks the sign-up", () => {
  const config = deriveConfig(
    configFileSchema.parse(baseConfig()),
    [],
    BUILT_IN_ROLES
  )

  function hooksWith(thrown: unknown) {
    const logged: { message: string; fields?: unknown }[] = []
    const logger = {
      error: (message: string, fields?: unknown) =>
        logged.push({ message, fields }),
    } as unknown as Logger
    const database = {
      db: {
        select: () => {
          throw thrown
        },
      },
      schema: { user: {} },
    } as unknown as DbHandle
    const mailer = { enabled: true, send: async () => {} } as unknown as Mailer

    return {
      logged,
      hooks: buildDatabaseHooks({ config, database, mailer, logger }),
    }
  }

  async function fire(hooks: ReturnType<typeof buildDatabaseHooks>) {
    // A pending self-registration: the case that would notify.
    await hooks!.user!.create!.after!(
      { status: "pending", email: "applicant@example.com" } as never,
      { path: "/sign-up/email" } as never
    )
  }

  it("swallows and logs a failure while looking up the admins", async () => {
    // The account is already written by the time this runs. Refusing the
    // registration because the notification failed would be the wrong trade.
    const { hooks, logged } = hooksWith(new Error("connection reset"))
    await expect(fire(hooks)).resolves.toBeUndefined()
    expect(logged).toHaveLength(1)
    expect(logged[0]!.fields).toMatchObject({ error: "connection reset" })
  })

  it("copes with something thrown that is not an Error", async () => {
    const { hooks, logged } = hooksWith("a bare string")
    await expect(fire(hooks)).resolves.toBeUndefined()
    expect(logged[0]!.fields).toMatchObject({ error: "a bare string" })
  })
})
