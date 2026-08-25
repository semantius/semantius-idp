/**
 * `idp reset-admin` — the lockout recovery, against a real database
 * (OPS-6, FR-ADMIN-1).
 *
 * This is the command that replaces `drop schema idp cascade` as the answer to
 * "the only administrator forgot the password they set at first sign-in". It
 * is worth testing against a live instance rather than a mock for one reason
 * above all: the *proof* that it worked is that the resulting password signs
 * in, and only a real Better Auth instance can say so.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import { ResetAdminError, resetAdmin } from "@/server/admin/reset-admin"
import { createAudit } from "@/server/audit"
import { createDb } from "@/server/db/client"
import type { DbHandle } from "@/server/db/client"
import { createLogger } from "@/server/logger"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const ADMIN = "reset-admin@example.com"
const OTHER = "not-an-admin@example.com"
const BOOTSTRAP_PASSWORD = "bootstrap-password-that-is-long"
const CHOSEN_PASSWORD = "the-password-only-they-knew"

let context: TestContext
let locking: DbHandle
const logger = createLogger({ level: "error", write: () => {} })

/** The deps the CLI assembles, minus the CLI. */
function deps() {
  return {
    config: context.config,
    database: context.database,
    locking,
    auth: context.auth,
    logger,
    audit: createAudit(context.database, logger),
  }
}

async function signIn(
  email: string,
  password: string
): Promise<{ status: number; cookie?: string }> {
  const response = await context.auth.handler(
    authRequest("/sign-in/email", { json: { email, password } })
  )
  return { status: response.status, cookie: sessionCookie(response) }
}

async function userRow(email: string) {
  const { user } = context.database.schema
  const [row] = await context.database.db
    .select()
    .from(user)
    .where(eq(user.email, email))
    .limit(1)
  return row
}

beforeAll(async () => {
  context = await createTestContext("reset_admin", {
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      admin: {
        bootstrap: {
          email: ADMIN,
          password: BOOTSTRAP_PASSWORD,
          name: "Bootstrap Admin",
        },
      },
    },
  })
  locking = createDb(context.config, { direct: true, max: 2 })
}, 120_000)

afterAll(async () => {
  await locking.close().catch(() => undefined)
  await context.teardown()
})

describe("on a database with no such account", () => {
  it("creates the administrator, forced to change at first sign-in", async () => {
    const result = await resetAdmin(deps())

    expect(result.created).toBe(true)
    expect(result.email).toBe(ADMIN)
    expect(result.role).toBe("admin")

    const row = await userRow(ADMIN)
    expect(row?.role).toBe("admin")
    expect(row?.status).toBe("active")
    expect(row?.mustChangePassword).toBe(true)
    expect(row?.emailVerified).toBe(true)

    // The point of the whole exercise: the configured password signs in.
    await expect(signIn(ADMIN, BOOTSTRAP_PASSWORD)).resolves.toMatchObject({
      status: 200,
    })
  })
})

describe("on the account it just created", () => {
  it("puts the password back and re-arms the forced change", async () => {
    // Live through the incident: sign in, change the password to something
    // only the operator knows, and lose it.
    const first = await signIn(ADMIN, BOOTSTRAP_PASSWORD)
    expect(first.cookie).toBeTruthy()
    const changed = await context.auth.handler(
      authRequest("/change-password", {
        headers: { cookie: first.cookie! },
        json: {
          currentPassword: BOOTSTRAP_PASSWORD,
          newPassword: CHOSEN_PASSWORD,
        },
      })
    )
    expect(changed.status).toBe(200)
    // The change ended the forced state — otherwise there would be nothing to
    // re-arm and this test would prove nothing.
    expect((await userRow(ADMIN))?.mustChangePassword).toBe(false)
    await expect(signIn(ADMIN, BOOTSTRAP_PASSWORD)).resolves.toMatchObject({
      status: 401,
    })

    const result = await resetAdmin(deps())

    expect(result.created).toBe(false)
    expect(result.sessionsRevoked).toBeGreaterThan(0)

    const row = await userRow(ADMIN)
    expect(row?.mustChangePassword).toBe(true)

    await expect(signIn(ADMIN, BOOTSTRAP_PASSWORD)).resolves.toMatchObject({
      status: 200,
    })
    // And the password that replaced it is gone.
    await expect(signIn(ADMIN, CHOSEN_PASSWORD)).resolves.toMatchObject({
      status: 401,
    })
  })

  it("brings back an administrator who banned themselves", async () => {
    const { user } = context.database.schema
    await context.database.db
      .update(user)
      .set({ banned: true, banReason: "self-inflicted", status: "rejected" })
      .where(eq(user.email, ADMIN))

    const result = await resetAdmin(deps())

    expect(result.reactivated).toBe(true)
    const row = await userRow(ADMIN)
    expect(row?.banned).toBe(false)
    expect(row?.banReason).toBeNull()
    expect(row?.status).toBe("active")
  })
})

describe("what it refuses", () => {
  it("will not grant an admin role to an address that has none", async () => {
    const registered = await context.auth.handler(
      authRequest("/sign-up/email", {
        json: { email: OTHER, password: CHOSEN_PASSWORD, name: "Someone" },
      })
    )
    expect(registered.status).toBe(200)

    // A local command that promoted whoever it was pointed at would be a
    // one-line privilege escalation for anyone who can read the config folder.
    await expect(resetAdmin(deps(), { email: OTHER })).rejects.toThrow(
      ResetAdminError
    )
    expect((await userRow(OTHER))?.role ?? "user").not.toContain("admin")
  })

  it("will not create an account for an address typed on the command line", async () => {
    // A typo must fail, not quietly provision a second administrator.
    await expect(
      resetAdmin(deps(), { email: "adnim@example.com" })
    ).rejects.toThrow(/IDP_ADMIN_EMAIL/)
    expect(await userRow("adnim@example.com")).toBeUndefined()
  })

  it("says so when there is no configured password to reset to", async () => {
    const withoutPassword = {
      ...deps(),
      config: {
        ...context.config,
        file: {
          ...context.config.file,
          admin: {
            ...context.config.file.admin,
            bootstrap: {
              email: ADMIN,
              name: "Bootstrap Admin",
              password: "",
            },
          },
        },
      },
    }

    await expect(resetAdmin(withoutPassword)).rejects.toThrow(
      /IDP_ADMIN_PASSWORD/
    )
  })
})
