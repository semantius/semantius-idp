/**
 * Key rotation without a verification gap (FR-OIDC-16, risk R11).
 *
 * The property under test is a *timing* one, and it is the reason the module
 * exists: a key must be published before it signs anything. Better Auth on its
 * own mints a replacement the moment the current key expires and signs with it
 * immediately — every verifier holding a cached JWKS then rejects those tokens
 * for as long as its cache lasts, with `no applicable key found` and nothing
 * in the IdP's logs to explain it.
 */

import { describe, expect, it } from "vitest"

import { decodeProtectedHeader } from "jose"
import { eq } from "drizzle-orm"

import { createLogger } from "@/server/logger"
import { rotateKeys } from "@/server/oidc/rotate-keys"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const EMAIL = "rotation@example.com"
const PASSWORD = "correct-horse-battery-staple"

async function context(label: string): Promise<TestContext> {
  return createTestContext(label, {
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
    },
  })
}

/** Forces the first key into existence, the way start-up does. */
async function publishedKeys(ctx: TestContext): Promise<string[]> {
  const response = await ctx.auth.handler(
    new Request("http://localhost:3000/api/auth/jwks")
  )
  const { keys } = (await response.json()) as { keys: { kid: string }[] }
  return keys.map((key) => key.kid)
}

/** A session JWT, so the header's `kid` says which key signed it. */
async function signingKid(ctx: TestContext): Promise<string | undefined> {
  await ctx.auth.handler(
    authRequest("/sign-up/email", {
      json: { email: EMAIL, password: PASSWORD, name: "Rotation" },
    })
  )
  const signedIn = await ctx.auth.handler(
    authRequest("/sign-in/email", {
      json: { email: EMAIL, password: PASSWORD },
    })
  )
  const cookie = sessionCookie(signedIn)
  const token = await ctx.auth.handler(
    new Request("http://localhost:3000/api/auth/token", {
      headers: { cookie: cookie! },
    })
  )
  const { token: jwt } = (await token.json()) as { token: string }
  return decodeProtectedHeader(jwt).kid
}

function rotate(ctx: TestContext, propagationSeconds: number) {
  return rotateKeys(
    {
      config: ctx.config,
      database: ctx.database,
      locking: ctx.database,
      auth: ctx.auth,
      logger: createLogger({ level: "error", write: () => {} }),
    },
    { propagationSeconds }
  )
}

describe("rotateKeys", () => {
  it("publishes the successor before it signs anything (risk R11)", async () => {
    const ctx = await context("rotate_publish_first")
    try {
      await publishedKeys(ctx)
      const before = await signingKid(ctx)
      expect(before).toBeTruthy()

      const result = await rotate(ctx, 3600)

      // Published straight away: a verifier that refreshes its cache now
      // already has the key it will need in an hour.
      expect(await publishedKeys(ctx)).toContain(result.successorKeyId)
      // But still signing with the old one, which is the whole point.
      expect(await signingKid(ctx)).toBe(before)
      expect(result.retiringKeyId).toBe(before)
    } finally {
      await ctx.teardown()
    }
  })

  it("hands over when the propagation window closes", async () => {
    const ctx = await context("rotate_handover")
    try {
      await publishedKeys(ctx)
      const before = await signingKid(ctx)

      // A window that has already elapsed: the retiring key's expiry is in
      // the past, so the successor is the newest key still live.
      const result = await rotate(ctx, -1)
      expect(await signingKid(ctx)).toBe(result.successorKeyId)
      expect(result.successorKeyId).not.toBe(before)
    } finally {
      await ctx.teardown()
    }
  })

  it("keeps the retired key published so old tokens still verify", async () => {
    const ctx = await context("rotate_grace")
    try {
      await publishedKeys(ctx)
      const before = await signingKid(ctx)
      const result = await rotate(ctx, -1)

      const published = await publishedKeys(ctx)
      // FR-OIDC-16: a token signed a second before the rotation has to keep
      // verifying, which means the retired key stays in the set for the
      // grace period.
      expect(published).toContain(before)
      expect(published).toContain(result.successorKeyId)
    } finally {
      await ctx.teardown()
    }
  })

  it("does not push back a key that was already expiring sooner", async () => {
    const ctx = await context("rotate_expiry")
    try {
      await publishedKeys(ctx)
      const before = await signingKid(ctx)

      const soon = new Date(Date.now() + 60_000)
      await ctx.database.db
        .update(ctx.database.schema.jwks)
        .set({ expiresAt: soon })
        .where(eq(ctx.database.schema.jwks.id, before!))

      await rotate(ctx, 86_400)

      const [row] = await ctx.database.db
        .select({ expiresAt: ctx.database.schema.jwks.expiresAt })
        .from(ctx.database.schema.jwks)
        .where(eq(ctx.database.schema.jwks.id, before!))
      // Brought forward, never pushed back: a rotation must not extend the
      // life of the key it is replacing.
      expect(row?.expiresAt?.getTime()).toBe(soon.getTime())
    } finally {
      await ctx.teardown()
    }
  })

  it("records the rotation (SEC-6)", async () => {
    const ctx = await context("rotate_audit")
    try {
      await publishedKeys(ctx)
      const audit = {
        record: async () => undefined,
        recordDetached: () => undefined,
      }
      const spy: Record<string, unknown>[] = []
      await rotateKeys(
        {
          config: ctx.config,
          database: ctx.database,
          locking: ctx.database,
          auth: ctx.auth,
          audit: {
            ...audit,
            record: async (event) => {
              spy.push(event as unknown as Record<string, unknown>)
            },
          },
        },
        { propagationSeconds: 3600 }
      )
      expect(spy).toHaveLength(1)
      expect(spy[0]?.action).toBe("keys.rotated")
    } finally {
      await ctx.teardown()
    }
  })
})
