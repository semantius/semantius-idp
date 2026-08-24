/**
 * The refusals that keep an administrator from locking everyone out
 * (FR-ADMIN-3, FR-ROLE-3).
 *
 * The matrix matters more than any single case: the rules interact, and the
 * interesting failures are the combinations — a lone admin who is also
 * suspended, a demotion that keeps admin among several roles, a "fallback"
 * admin nobody could ever sign in as.
 */

import { describe, expect, it } from "vitest"

import type {
  AdminInvariantError,
  AdminAction,
  AdminInvariantUser,
} from "@/server/admin/invariants"
import {
  ADMIN_INVARIANTS,
  assertAdminInvariants,
  isUsableAdmin,
} from "@/server/admin/invariants"

const ADMIN_ROLES = ["admin", "owner"]

function user(over: Partial<AdminInvariantUser> & { id: string }) {
  return { role: "user", status: "active", banned: false, ...over }
}

const ALICE = user({ id: "alice", role: "admin" })
const BOB = user({ id: "bob", role: "admin" })
const CARL = user({ id: "carl" })

function check(
  actor: AdminInvariantUser,
  target: AdminInvariantUser,
  action: AdminAction,
  admins: AdminInvariantUser[]
) {
  return () =>
    assertAdminInvariants({
      actor,
      target,
      action,
      adminRoles: ADMIN_ROLES,
      admins,
    })
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as AdminInvariantError).code
  }
}

describe("self-actions", () => {
  it("refuses every destructive action against oneself", () => {
    const cases: [AdminAction, string][] = [
      [{ kind: "set-role", roles: ["admin"] }, ADMIN_INVARIANTS.SELF_ROLE],
      [{ kind: "ban" }, ADMIN_INVARIANTS.SELF_BAN],
      [{ kind: "reject" }, ADMIN_INVARIANTS.SELF_BAN],
      [{ kind: "delete" }, ADMIN_INVARIANTS.SELF_DELETE],
      [{ kind: "impersonate" }, ADMIN_INVARIANTS.SELF_IMPERSONATE],
    ]
    for (const [action, code] of cases) {
      expect(codeOf(check(ALICE, ALICE, action, [ALICE, BOB]))).toBe(code)
    }
  })

  it("allows unbanning oneself — it can only ever help", () => {
    // Not reachable through the UI, but an admin who was banned and then
    // restored by a colleague should not be refused on their own row.
    expect(check(ALICE, ALICE, { kind: "unban" }, [ALICE, BOB])).not.toThrow()
  })

  it("prefers the last-admin message when there is nobody else to ask", () => {
    // Both rules fit, and the ordering is the substance. "Ask another
    // administrator" is exactly wrong for the only administrator there is —
    // it is advice with nobody at the other end. "Give another account an
    // admin role first" is something they can go and do.
    expect(codeOf(check(ALICE, ALICE, { kind: "ban" }, [ALICE]))).toBe(
      ADMIN_INVARIANTS.LAST_ADMIN
    )
    // And with a colleague around, the self message is the right one again.
    expect(codeOf(check(ALICE, ALICE, { kind: "ban" }, [ALICE, BOB]))).toBe(
      ADMIN_INVARIANTS.SELF_BAN
    )
  })
})

describe("the last administrator", () => {
  it("refuses to remove the only one, by any route", () => {
    for (const action of [
      { kind: "ban" } as const,
      { kind: "delete" } as const,
      { kind: "reject" } as const,
      { kind: "set-role", roles: ["user"] } as const,
    ]) {
      expect(codeOf(check(BOB, ALICE, action, [ALICE]))).toBe(
        ADMIN_INVARIANTS.LAST_ADMIN
      )
    }
  })

  it("allows it once a second usable admin exists", () => {
    expect(
      check(BOB, ALICE, { kind: "set-role", roles: ["user"] }, [ALICE, BOB])
    ).not.toThrow()
  })

  it("does not count an admin who cannot sign in", () => {
    // The whole point: a suspended or unapproved admin is not a fallback.
    const suspended = user({ id: "bob", role: "admin", banned: true })
    const pending = user({ id: "bob", role: "admin", status: "pending" })
    for (const fallback of [suspended, pending]) {
      expect(
        codeOf(check(CARL, ALICE, { kind: "delete" }, [ALICE, fallback]))
      ).toBe(ADMIN_INVARIANTS.LAST_ADMIN)
    }
  })

  it("counts one whose temporary ban has lapsed", () => {
    const lapsed = user({
      id: "bob",
      role: "admin",
      banned: true,
      banExpires: new Date(Date.now() - 1000),
    })
    expect(
      check(CARL, ALICE, { kind: "delete" }, [ALICE, lapsed])
    ).not.toThrow()
  })

  it("recognises any configured admin role, not just `admin`", () => {
    const owner = user({ id: "bob", role: "owner" })
    expect(check(CARL, ALICE, { kind: "delete" }, [ALICE, owner])).not.toThrow()
  })

  it("lets a demotion through when admin survives among the new roles", () => {
    expect(
      check(BOB, ALICE, { kind: "set-role", roles: ["support", "admin"] }, [
        ALICE,
      ])
    ).not.toThrow()
  })

  it("says nothing about a target who was never an admin", () => {
    // No admin is lost, so the count is irrelevant even at zero fallbacks.
    expect(check(ALICE, CARL, { kind: "delete" }, [ALICE])).not.toThrow()
    expect(check(ALICE, CARL, { kind: "ban" }, [ALICE])).not.toThrow()
  })

  it("ignores an already-suspended admin — nothing is lost by deleting them", () => {
    const suspended = user({ id: "dora", role: "admin", banned: true })
    expect(
      check(ALICE, suspended, { kind: "delete" }, [ALICE, suspended])
    ).not.toThrow()
  })
})

describe("granting admin", () => {
  it("refuses when the actor is no longer an admin themselves", () => {
    // The endpoint gate passed, then the actor's own role was taken away. The
    // write must not go through on the strength of a stale check.
    expect(
      codeOf(check(CARL, BOB, { kind: "set-role", roles: ["admin"] }, [ALICE]))
    ).toBe(ADMIN_INVARIANTS.NOT_AN_ADMIN)
  })

  it("allows an admin to promote someone", () => {
    expect(
      check(ALICE, CARL, { kind: "set-role", roles: ["admin"] }, [ALICE])
    ).not.toThrow()
  })

  it("lets a non-admin actor set a non-admin role", () => {
    // This gate is about *admin* specifically; ordinary role edits are the
    // endpoint's business, and it has its own gate.
    expect(
      check(CARL, BOB, { kind: "set-role", roles: ["support"] }, [ALICE, BOB])
    ).not.toThrow()
  })
})

describe("isUsableAdmin", () => {
  it("needs an admin role, an active status and no live ban", () => {
    expect(isUsableAdmin(ALICE, ADMIN_ROLES)).toBe(true)
    expect(isUsableAdmin(CARL, ADMIN_ROLES)).toBe(false)
    expect(
      isUsableAdmin(
        user({ id: "x", role: "admin", status: "rejected" }),
        ADMIN_ROLES
      )
    ).toBe(false)
    // An unknown status is not treated as active; only `active` is.
    expect(
      isUsableAdmin({ id: "x", role: "admin", status: undefined }, ADMIN_ROLES)
    ).toBe(true)
  })
})
