/**
 * The freshness arithmetic on its own (FR-AUTH-5), and what the gate does with
 * the answer (**D63**).
 *
 * Which clock the answer comes from is the whole decision: measured from
 * `createdAt` it means "how long since a password was typed", measured from
 * `updatedAt` it would mean "how long since the last request", and every
 * session would be permanently fresh.
 *
 * The second half is newer and has a rule that has to hold: a draft is stashed
 * for a session that is **stale**, and never for one that is **absent**. The
 * store is a `verification` row and these route handlers sit in front of no
 * rate limiter, so an anonymous POST must not be able to write into it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  isFresh,
  reauthTarget,
  requireFreshSession,
} from "@/server/http/fresh-session"
import type { RouteSession } from "@/server/http/session"
import type { Runtime } from "@/server/runtime"

const readSession = vi.hoisted(() => vi.fn())
const stash = vi.hoisted(() => vi.fn())

vi.mock("@/server/http/session", () => ({ readSession }))
vi.mock("@/server/http/one-shot", () => ({
  stash,
  claim: vi.fn(),
}))

const NOW = Date.parse("2026-08-24T12:00:00.000Z")

function sessionCreatedMinutesAgo(minutes: number): RouteSession {
  return {
    user: {
      id: "user-1",
      email: "user@example.com",
      name: "User",
      emailVerified: true,
      roles: [],
      twoFactorEnabled: false,
      mustChangePassword: false,
    },
    session: {
      id: "session-1",
      token: "token",
      createdAt: new Date(NOW - minutes * 60_000),
      // Deliberately just now: a session used a second ago is still stale if
      // it was created an hour ago, and this is what proves the distinction.
      expiresAt: new Date(NOW + 86_400_000),
    },
  }
}

describe("isFresh", () => {
  it("accepts a session inside the window", () => {
    expect(isFresh(sessionCreatedMinutesAgo(0), 15, NOW)).toBe(true)
    expect(isFresh(sessionCreatedMinutesAgo(14), 15, NOW)).toBe(true)
  })

  it("accepts one exactly on the boundary", () => {
    // The window is "fresher than 15 minutes"; a session at exactly 15 has
    // not yet fallen outside it, and rejecting it would make the boundary
    // depend on millisecond timing.
    expect(isFresh(sessionCreatedMinutesAgo(15), 15, NOW)).toBe(true)
  })

  it("rejects one past it", () => {
    expect(isFresh(sessionCreatedMinutesAgo(16), 15, NOW)).toBe(false)
    expect(isFresh(sessionCreatedMinutesAgo(20), 15, NOW)).toBe(false)
  })

  it("honours the configured window rather than a constant", () => {
    const session = sessionCreatedMinutesAgo(30)
    expect(isFresh(session, 15, NOW)).toBe(false)
    expect(isFresh(session, 60, NOW)).toBe(true)
  })

  it("rejects a session with an unreadable creation time", () => {
    const broken = sessionCreatedMinutesAgo(0)
    broken.session.createdAt = new Date("not a date")
    // Failing closed: an unparseable timestamp is not evidence of freshness.
    expect(isFresh(broken, 15, NOW)).toBe(false)
  })
})

describe("reauthTarget", () => {
  it("carries the notice and the return path", () => {
    expect(reauthTarget("", "/admin/clients", "reauth")).toBe(
      "/login?notice=reauth&returnTo=%2Fadmin%2Fclients"
    )
  })

  it("survives a sub-path mount and a returnTo that has its own query", () => {
    // The handle travels *inside* `returnTo`, encoded, so `safeReturnTo` on
    // the way back sees one same-origin relative path (D63).
    expect(
      reauthTarget("/idp", "/admin/clients?draft=abc", "reauth_draft")
    ).toBe(
      "/idp/login?notice=reauth_draft&returnTo=%2Fadmin%2Fclients%3Fdraft%3Dabc"
    )
  })
})

describe("requireFreshSession", () => {
  /**
   * Relative to the real clock, unlike the fixed `NOW` above: the gate reads
   * `Date.now()` itself, and it is the gate's branching that is under test
   * here rather than the arithmetic.
   */
  const sessionAged = (minutes: number): RouteSession => {
    const session = sessionCreatedMinutesAgo(0)
    session.session.createdAt = new Date(Date.now() - minutes * 60_000)
    return session
  }

  const runtime = {
    config: {
      base: { basePath: "" },
      file: { session: { freshAgeMinutes: 15 } },
    },
  } as unknown as Runtime

  const post = () => new Request("https://idp.example.com/admin/clients")

  beforeEach(() => {
    readSession.mockReset()
    stash.mockReset()
    stash.mockResolvedValue("handle-1")
  })

  it("lets a fresh session through", async () => {
    readSession.mockResolvedValue(sessionAged(1))
    const result = await requireFreshSession(runtime, post(), "/admin/clients", {
      draft: { name: "Example" },
    })
    expect(result.ok).toBe(true)
    expect(stash).not.toHaveBeenCalled()
  })

  it("stashes the draft for a stale session and says so", async () => {
    readSession.mockResolvedValue(sessionAged(20))
    const result = await requireFreshSession(runtime, post(), "/admin/clients", {
      draft: { name: "Example" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const location = result.response.headers.get("location") ?? ""
    expect(location).toContain("notice=reauth_draft")
    expect(location).toContain(encodeURIComponent("?draft=handle-1"))
    expect(stash).toHaveBeenCalledTimes(1)
  })

  it("never stashes for a caller with no session", async () => {
    readSession.mockResolvedValue(null)
    const result = await requireFreshSession(runtime, post(), "/admin/clients", {
      draft: { name: "Example" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.headers.get("location")).toContain(
      "notice=signin_required"
    )
    expect(stash).not.toHaveBeenCalled()
  })

  it("bounces without a handle when the caller kept no draft", async () => {
    readSession.mockResolvedValue(sessionAged(20))
    const result = await requireFreshSession(runtime, post(), "/account/security")
    expect(result.ok).toBe(false)
    if (result.ok) return
    const location = result.response.headers.get("location") ?? ""
    expect(location).toContain("notice=reauth")
    expect(location).not.toContain("draft")
    expect(stash).not.toHaveBeenCalled()
  })
})
