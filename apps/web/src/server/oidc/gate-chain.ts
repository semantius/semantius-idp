/**
 * The order the interstitials happen in (FR-OIDC-9, FR-AUTH-4, FR-SIGNUP-2).
 *
 * An authorization request can be interrupted by four different things, and
 * the order is not arbitrary — each one is a precondition for the next being
 * meaningful:
 *
 *  1. **No session** → sign in. Nothing else can be decided about a stranger.
 *  2. **Not approved, or suspended** → the status page. A `pending` user must
 *     not obtain an authorization code on any path (FR-SIGNUP-2), and this is
 *     the path a naive implementation forgets, because the *session* is valid.
 *  3. **Must change the password** → the forced change (FR-AUTH-4). A
 *     temporary password is changed "before anything else completes,
 *     including an OAuth continuation" — the spec says so in as many words.
 *  4. Otherwise the provider takes over, and decides consent for itself.
 *
 * **Why this exists at all.** Better Auth's authorize endpoint checks for a
 * session and nothing else: with `skipConsent` on, a live session belonging to
 * a banned user, or to one who has never completed a forced password change,
 * gets an authorization code. The session outlives the state that should have
 * ended it, and the chain — not session creation — is what catches that.
 */

import { APP_ROUTES } from "./base-path"

export type Gate =
  | { kind: "signin" }
  | { kind: "pending" }
  | { kind: "banned" }
  | { kind: "change-password" }

export interface GateUser {
  status?: string | null
  banned?: boolean | null
  banExpires?: Date | string | null
  mustChangePassword?: boolean | null
}

export interface GateInput {
  /** `null` when nobody is signed in. */
  user: GateUser | null
}

/**
 * The first gate that applies, or `undefined` when the request may proceed.
 *
 * Pure, so the ordering is testable without a session, a client or a database.
 */
export function nextGate({ user }: GateInput): Gate | undefined {
  if (!user) return { kind: "signin" }

  if (user.banned === true && !banHasExpired(user.banExpires)) {
    return { kind: "banned" }
  }

  const status = user.status ?? "pending"
  if (status === "pending") return { kind: "pending" }
  // A rejected account is refused the same way a suspended one is: SEC-7
  // keeps the two indistinguishable from outside.
  if (status === "rejected") return { kind: "banned" }

  if (user.mustChangePassword === true) return { kind: "change-password" }

  return undefined
}

/** Where a gate sends the browser, relative to the mount path. */
export function gateRoute(gate: Gate): string {
  switch (gate.kind) {
    case "signin":
      return APP_ROUTES.login
    case "pending":
      return APP_ROUTES.pendingApproval
    case "banned":
      return APP_ROUTES.banned
    case "change-password":
      return APP_ROUTES.changePassword
  }
}

/** Whether the gate's page should carry a `returnTo` back to the request. */
export function gateResumes(gate: Gate): boolean {
  // The status pages are terminal: there is nothing to come back to until an
  // administrator acts, and a `returnTo` on them would be a promise the page
  // cannot keep.
  return gate.kind === "signin" || gate.kind === "change-password"
}

function banHasExpired(banExpires: Date | string | null | undefined): boolean {
  if (!banExpires) return false
  const expiry = banExpires instanceof Date ? banExpires : new Date(banExpires)
  return Number.isFinite(expiry.getTime()) && expiry.getTime() <= Date.now()
}
