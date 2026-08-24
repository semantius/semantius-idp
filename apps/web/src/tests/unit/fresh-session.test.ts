/**
 * The freshness arithmetic on its own (FR-AUTH-5).
 *
 * Which clock the answer comes from is the whole decision: measured from
 * `createdAt` it means "how long since a password was typed", measured from
 * `updatedAt` it would mean "how long since the last request", and every
 * session would be permanently fresh.
 */

import { describe, expect, it } from "vitest"

import { isFresh } from "@/server/http/fresh-session"
import type { RouteSession } from "@/server/http/session"

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
