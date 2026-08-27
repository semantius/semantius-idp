/**
 * The session gate (`http/require-session.ts`, **D81**).
 *
 * Two properties, and the second is the one worth a test: a caller with no
 * session is bounced to `/login` carrying where they were, and the read is
 * **authoritative** — it must not be answered from the cookie cache, because
 * a write authorised from the cache is a write authorised by a copy of the
 * session up to five minutes old.
 *
 * The predecessor's tests asserted a fifteen-minute window on
 * `session.createdAt`. That window is gone (D81): it could not be satisfied
 * by an account that authenticates through a provider, which is most of them.
 */

import { describe, expect, it, vi } from "vitest"

import { requireSession, signInTarget } from "@/server/http/require-session"
import type { Runtime } from "@/server/runtime"

function runtimeWith(session: unknown, basePath = "") {
  const getSession = vi.fn().mockResolvedValue(session)
  const runtime = {
    auth: { api: { getSession } },
    config: { base: { basePath } },
  } as unknown as Runtime
  return { runtime, getSession }
}

const post = () =>
  new Request("http://localhost:3000/admin/clients", { method: "POST" })

describe("signInTarget", () => {
  it("carries the return path, encoded", () => {
    expect(signInTarget("", "/admin/clients")).toBe(
      "/login?notice=signin_required&returnTo=%2Fadmin%2Fclients"
    )
  })

  it("keeps a query on the return path across the round trip", () => {
    // `?draft=…` rides here on the error paths (D62), and `safeReturnTo` at
    // the other end must see one same-origin relative path.
    expect(signInTarget("/idp", "/admin/clients?draft=abc")).toBe(
      "/idp/login?notice=signin_required&returnTo=%2Fadmin%2Fclients%3Fdraft%3Dabc"
    )
  })
})

describe("requireSession", () => {
  it("passes a caller who has a session, however old", async () => {
    const { runtime } = runtimeWith({
      user: { id: "u1", email: "a@example.com", roles: [] },
      session: {
        id: "s1",
        token: "t",
        // A year ago: age is no longer a reason to refuse.
        createdAt: new Date(Date.now() - 365 * 24 * 60 * 60_000),
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    const result = await requireSession(runtime, post(), "/admin/clients")

    expect(result.ok).toBe(true)
  })

  it("bounces a caller with no session to sign in", async () => {
    const { runtime } = runtimeWith(null)

    const result = await requireSession(runtime, post(), "/admin/clients")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(303)
      expect(result.response.headers.get("location")).toBe(
        "/login?notice=signin_required&returnTo=%2Fadmin%2Fclients"
      )
    }
  })

  it("reads the row, never the cookie cache", async () => {
    const { runtime, getSession } = runtimeWith(null)

    await requireSession(runtime, post(), "/admin/clients")

    expect(getSession).toHaveBeenCalledTimes(1)
    const [call] = getSession.mock.calls
    const args = call?.[0] as
      | { query?: { disableCookieCache?: boolean } }
      | undefined
    expect(args?.query?.disableCookieCache).toBe(true)
  })
})
