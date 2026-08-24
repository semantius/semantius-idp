/**
 * The single-use server-side stash (FR-2FA-1).
 *
 * It exists so a TOTP secret and its backup codes can travel from a form POST
 * to the page that shows them without going through the URL — where they would
 * survive in browser history, in `Referer` and in every proxy log on the way.
 * Three properties make that worth having, and all three are asserted here:
 * the value comes back once, it does not come back twice, and an expired
 * handle is indistinguishable from an invented one.
 */

import { describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import { claim, stash } from "@/server/http/one-shot"
import type { Runtime } from "@/server/runtime"
import type { TestContext } from "./harness"
import { createTestContext } from "./harness"

function runtimeFor(context: TestContext): Runtime {
  return { auth: context.auth } as unknown as Runtime
}

describe("one-shot stash", () => {
  it("hands the value back exactly once", async () => {
    const context = await createTestContext("one_shot_once")
    try {
      const runtime = runtimeFor(context)
      const handle = await stash(runtime, "the-secret")

      expect(await claim(runtime, handle)).toBe("the-secret")
      // A refresh of the landing page must show the value gone, not show it
      // again to whoever has the URL.
      expect(await claim(runtime, handle)).toBeUndefined()
    } finally {
      await context.teardown()
    }
  })

  it("answers the same way for an unknown handle", async () => {
    const context = await createTestContext("one_shot_unknown")
    try {
      const runtime = runtimeFor(context)
      expect(await claim(runtime, "not-a-handle")).toBeUndefined()
      expect(await claim(runtime, undefined)).toBeUndefined()
    } finally {
      await context.teardown()
    }
  })

  it("refuses a handle whose window has closed", async () => {
    const context = await createTestContext("one_shot_expired")
    try {
      const runtime = runtimeFor(context)
      const handle = await stash(runtime, "the-secret", { ttlSeconds: 600 })

      const { verification } = context.database.schema
      await context.database.db
        .update(verification)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(verification.identifier, `one-shot-${handle}`))

      expect(await claim(runtime, handle)).toBeUndefined()
    } finally {
      await context.teardown()
    }
  })

  it("gives every stash an unguessable handle", async () => {
    const context = await createTestContext("one_shot_handles")
    try {
      const runtime = runtimeFor(context)
      const handles = await Promise.all(
        Array.from({ length: 5 }, () => stash(runtime, "x"))
      )
      expect(new Set(handles).size).toBe(5)
      // 32 random bytes, base64url: the handle is the only thing between the
      // URL and the value.
      for (const handle of handles) expect(handle.length).toBeGreaterThan(40)
    } finally {
      await context.teardown()
    }
  })
})
