/**
 * API keys.
 *
 * A key authenticates **as its owner**, with the owner's roles, so the
 * interesting assertions are not "can I make one" but the four ways it has to
 * stop working: revoked, expired, owner banned, owner not approved. Each of
 * those is a separate decision in a different place, and a key that keeps
 * working after any of them is a live credential nobody can see.
 */

import { describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import { readSession } from "@/server/http/session"
import type { Runtime } from "@/server/runtime"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const PASSWORD = "correct-horse-battery-staple"
const EMAIL = "keys@example.com"

async function contextWith(
  label: string,
  apiKeys: Record<string, unknown> = {}
): Promise<TestContext> {
  return createTestContext(label, {
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      apiKeys: { enabled: true, ...apiKeys },
    },
  })
}

async function signedIn(context: TestContext): Promise<string> {
  await context.auth.handler(
    authRequest("/sign-up/email", {
      json: { email: EMAIL, password: PASSWORD, name: "Key Owner" },
    })
  )
  const response = await context.auth.handler(
    authRequest("/sign-in/email", {
      json: { email: EMAIL, password: PASSWORD },
    })
  )
  const cookie = sessionCookie(response)
  expect(cookie).toBeTruthy()
  return cookie!
}

async function createKey(
  context: TestContext,
  cookie: string,
  body: Record<string, unknown> = {}
): Promise<{ id: string; key: string }> {
  const response = await context.auth.handler(
    authRequest("/api-key/create", {
      headers: { cookie },
      json: { name: "Test key", ...body },
    })
  )
  expect(response.status).toBe(200)
  const created = (await response.json()) as { id: string; key: string }
  expect(created.key, "the secret is returned exactly once").toBeTruthy()
  return created
}

/** Asks who the caller is, presenting the key instead of a cookie. */
async function whoAmI(context: TestContext, key: string): Promise<Response> {
  return context.auth.handler(
    authRequest("/get-session", {
      method: "GET",
      headers: { "x-api-key": key },
    })
  )
}

describe("API keys", () => {
  it("authenticates as the owner, with the owner's roles", async () => {
    const context = await contextWith("apikeys_owner")
    try {
      const cookie = await signedIn(context)
      const { key } = await createKey(context, cookie)

      const response = await whoAmI(context, key)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        user?: { email?: string; role?: string }
      }
      expect(body.user?.email).toBe(EMAIL)
      // The default role from the catalog, not something the key carries.
      expect(body.user?.role).toBe("user")
    } finally {
      await context.teardown()
    }
  })

  it("stores only a hash — the secret is never readable again", async () => {
    const context = await contextWith("apikeys_hashed")
    try {
      const cookie = await signedIn(context)
      const { id, key } = await createKey(context, cookie)

      const [row] = await context.database.db
        .select()
        .from(context.database.schema.apikey)
        .where(eq(context.database.schema.apikey.id, id))
      expect(row?.key).not.toBe(key)
      expect(row?.key).not.toContain(key)
      // The list page shows this, so it has to be a prefix and nothing more.
      expect(key.startsWith(row?.start ?? "")).toBe(true)
    } finally {
      await context.teardown()
    }
  })

  it("stops working once revoked", async () => {
    const context = await contextWith("apikeys_revoke")
    try {
      const cookie = await signedIn(context)
      const { id, key } = await createKey(context, cookie)
      expect((await whoAmI(context, key)).status).toBe(200)

      const deleted = await context.auth.handler(
        authRequest("/api-key/delete", {
          headers: { cookie },
          json: { keyId: id },
        })
      )
      expect(deleted.status).toBe(200)

      const after = await whoAmI(context, key)
      expect(after.status).toBeGreaterThanOrEqual(400)
    } finally {
      await context.teardown()
    }
  })

  it("stops working once expired", async () => {
    const context = await contextWith("apikeys_expiry")
    try {
      const cookie = await signedIn(context)
      const { id, key } = await createKey(context, cookie, {
        expiresIn: 86_400,
      })
      expect((await whoAmI(context, key)).status).toBe(200)

      // Backdating beats waiting a day, and exercises the same comparison.
      await context.database.db
        .update(context.database.schema.apikey)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(context.database.schema.apikey.id, id))

      const after = await whoAmI(context, key)
      expect(after.status).toBeGreaterThanOrEqual(400)
    } finally {
      await context.teardown()
    }
  })

  it("refuses a key whose owner has been banned", async () => {
    const context = await contextWith("apikeys_banned")
    try {
      const cookie = await signedIn(context)
      const { key } = await createKey(context, cookie)
      expect((await whoAmI(context, key)).status).toBe(200)

      await context.database.db
        .update(context.database.schema.user)
        .set({ banned: true })
        .where(eq(context.database.schema.user.email, EMAIL))

      const after = await whoAmI(context, key)
      expect(after.status).toBeGreaterThanOrEqual(400)

      // a refused key is an event worth having on record.
      const audit = await context.database.db
        .select()
        .from(context.database.schema.auditLog)
        .where(eq(context.database.schema.auditLog.action, "apikey.failed"))
      expect(audit).toHaveLength(1)
      expect(audit[0]?.outcome).toBe("failure")

      // the key was not deleted, so lifting the ban restores it.
      await context.database.db
        .update(context.database.schema.user)
        .set({ banned: false })
        .where(eq(context.database.schema.user.email, EMAIL))
      expect((await whoAmI(context, key)).status).toBe(200)
    } finally {
      await context.teardown()
    }
  })

  it("refuses a key whose owner is no longer approved", async () => {
    const context = await contextWith("apikeys_pending")
    try {
      const cookie = await signedIn(context)
      const { key } = await createKey(context, cookie)

      await context.database.db
        .update(context.database.schema.user)
        .set({ status: "pending" })
        .where(eq(context.database.schema.user.email, EMAIL))

      const after = await whoAmI(context, key)
      expect(after.status).toBeGreaterThanOrEqual(400)
    } finally {
      await context.teardown()
    }
  })
})

describe("API keys disabled", () => {
  it("registers no endpoints at all", async () => {
    const context = await createTestContext("apikeys_off", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        auth: { requireEmailVerification: false },
        apiKeys: { enabled: false },
      },
    })
    try {
      const cookie = await signedIn(context)
      const response = await context.auth.handler(
        authRequest("/api-key/create", {
          headers: { cookie },
          json: { name: "Test key" },
        })
      )
      expect(response.status).toBe(404)
    } finally {
      await context.teardown()
    }
  })
})

describe("reading the session", () => {
  it("reads the session the same way everywhere", async () => {
    const context = await createTestContext("apikeys_readsession", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        auth: { requireEmailVerification: false },
      },
    })
    try {
      const cookie = await signedIn(context)
      const runtime = {
        auth: context.auth,
        config: context.config,
      } as unknown as Runtime

      const session = await readSession(
        runtime,
        new Request("http://localhost:3000/account", { headers: { cookie } })
      )
      expect(session?.user.email).toBe(EMAIL)
      expect(session?.user.roles).toEqual(["user"])
      expect(session?.user.mustChangePassword).toBe(false)
    } finally {
      await context.teardown()
    }
  })
})
