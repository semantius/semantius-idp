/**
 * The order the interstitials happen in (FR-OIDC-9, FR-AUTH-4, FR-SIGNUP-2).
 *
 * Each case is a rule with a consequence, and the ordering is the substance:
 * a suspended user must not reach the consent screen, and a user with a
 * temporary password must not reach it *either*, because completing consent
 * would hand out an authorization code the temporary password paid for.
 */

import { describe, expect, it } from "vitest"

import { gateResumes, gateRoute, nextGate } from "@/server/oidc/gate-chain"

const ACTIVE = { status: "active", banned: false, mustChangePassword: false }

describe("nextGate", () => {
  it("sends a stranger to sign in", () => {
    expect(nextGate({ user: null })).toEqual({ kind: "signin" })
  })

  it("lets an ordinary active user straight through", () => {
    expect(nextGate({ user: ACTIVE })).toBeUndefined()
  })

  it("stops a user who is still waiting for approval (FR-SIGNUP-2)", () => {
    // The session is valid, which is exactly why this is easy to miss: the
    // gate has to look at the *user*, not at whether there is a session.
    expect(nextGate({ user: { ...ACTIVE, status: "pending" } })).toEqual({
      kind: "pending",
    })
    // An absent status is treated as pending, not as active.
    expect(nextGate({ user: { banned: false } })).toEqual({ kind: "pending" })
  })

  it("stops a suspended user, and a rejected one the same way (SEC-7)", () => {
    expect(nextGate({ user: { ...ACTIVE, banned: true } })).toEqual({
      kind: "banned",
    })
    expect(nextGate({ user: { ...ACTIVE, status: "rejected" } })).toEqual({
      kind: "banned",
    })
  })

  it("lets a user back in once a temporary ban has lapsed", () => {
    expect(
      nextGate({
        user: {
          ...ACTIVE,
          banned: true,
          banExpires: new Date(Date.now() - 1000),
        },
      })
    ).toBeUndefined()
    expect(
      nextGate({
        user: {
          ...ACTIVE,
          banned: true,
          banExpires: new Date(Date.now() + 60_000),
        },
      })
    ).toEqual({ kind: "banned" })
    // No expiry means permanent.
    expect(
      nextGate({ user: { ...ACTIVE, banned: true, banExpires: null } })
    ).toEqual({ kind: "banned" })
  })

  it("puts the forced password change before the authorization (FR-AUTH-4)", () => {
    expect(nextGate({ user: { ...ACTIVE, mustChangePassword: true } })).toEqual(
      { kind: "change-password" }
    )
  })

  it("checks the account's standing before its password", () => {
    // Both apply; the status gate wins, because "you are suspended" is the
    // true answer and asking a suspended user to choose a new password would
    // be a lie about what happens next.
    expect(
      nextGate({
        user: { status: "pending", banned: true, mustChangePassword: true },
      })
    ).toEqual({ kind: "banned" })
  })
})

describe("gateRoute", () => {
  it("names a page for every gate", () => {
    expect(gateRoute({ kind: "signin" })).toBe("/login")
    expect(gateRoute({ kind: "pending" })).toBe("/pending-approval")
    expect(gateRoute({ kind: "banned" })).toBe("/banned")
    expect(gateRoute({ kind: "change-password" })).toBe("/change-password")
  })
})

describe("gateResumes", () => {
  it("only carries a returnTo where there is something to come back to", () => {
    expect(gateResumes({ kind: "signin" })).toBe(true)
    expect(gateResumes({ kind: "change-password" })).toBe(true)
    // Terminal: nothing happens until an administrator acts, so a `returnTo`
    // would be a promise the page cannot keep.
    expect(gateResumes({ kind: "pending" })).toBe(false)
    expect(gateResumes({ kind: "banned" })).toBe(false)
  })
})
