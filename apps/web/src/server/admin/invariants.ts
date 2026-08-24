/**
 * The things an administrator must not be able to do, however they ask
 * (FR-ADMIN-3, FR-ROLE-3, SEC-7).
 *
 * Two classes of rule, and they exist for different reasons.
 *
 * **Self-actions.** An administrator cannot ban, delete, deactivate or
 * re-role *themselves*. Not because it would be catastrophic — the last-admin
 * rule below catches that case — but because every one of them is a mistake
 * rather than an intention: the button that locks you out of the tool you are
 * using was never the button you meant to press. Changing your own password,
 * name or e-mail is not covered here; that is what `/account` is for and it
 * works.
 *
 * **The last administrator.** The rule that actually protects the deployment:
 * the final account holding an admin role cannot be demoted, banned, rejected
 * or deleted, by anyone, including itself. Without it a two-admin deployment
 * can be reduced to zero in two clicks and the only way back is
 * `idp create-admin` on the server — recoverable, but only by someone with
 * shell access, which the person clicking usually is not.
 *
 * "Last" is counted over accounts that can *actually* sign in and administer:
 * an admin who is banned or not active is not a fallback, so demoting the only
 * usable admin is refused even when a dozen suspended ones exist. The count is
 * taken inside the same request as the change, which leaves a narrow race
 * between two concurrent demotions; the loser of that race gets a deployment
 * with no admin, so the check is *also* the reason `idp create-admin` exists
 * (D33).
 *
 * Nothing here reads the database. The caller supplies the candidate set,
 * because the two callers — this app's own endpoints and the wrapper around
 * Better Auth's admin endpoints — reach the rows by different routes, and a
 * pure function is the part worth testing exhaustively.
 */

import { isAdmin } from "../role-utils"

/** The subset of a user row these rules are decided on. */
export interface AdminInvariantUser {
  id: string
  role?: string | null
  status?: string | null
  banned?: boolean | null
  banExpires?: Date | null
}

/** What is being attempted, in the vocabulary of the rules rather than of HTTP. */
export type AdminAction =
  | { kind: "set-role"; roles: readonly string[] }
  | { kind: "ban" }
  | { kind: "unban" }
  | { kind: "delete" }
  | { kind: "reject" }
  | { kind: "impersonate" }

export interface AdminInvariantInput {
  /** Who is asking. */
  actor: AdminInvariantUser
  /** Who it is being done to. */
  target: AdminInvariantUser
  action: AdminAction
  /** Which role names count as administrative — `admin.adminRoles`. */
  adminRoles: readonly string[]
  /**
   * Every user who currently holds an admin role, the target included.
   * Only its size and membership matter, so a caller may pass a projection.
   */
  admins: readonly AdminInvariantUser[]
}

/** Machine-readable reasons, so the UI and the API say the same thing. */
export const ADMIN_INVARIANTS = {
  SELF_ROLE: "admin_cannot_change_own_roles",
  SELF_BAN: "admin_cannot_ban_self",
  SELF_DELETE: "admin_cannot_delete_self",
  SELF_IMPERSONATE: "admin_cannot_impersonate_self",
  LAST_ADMIN: "last_admin_protected",
  NOT_AN_ADMIN: "only_admins_grant_admin_roles",
} as const

export type AdminInvariantCode =
  (typeof ADMIN_INVARIANTS)[keyof typeof ADMIN_INVARIANTS]

/** Sentences for the API and the UI; the codes above are what tests assert on. */
export const ADMIN_INVARIANT_MESSAGES: Record<AdminInvariantCode, string> = {
  [ADMIN_INVARIANTS.SELF_ROLE]:
    "You cannot change your own roles. Ask another administrator.",
  [ADMIN_INVARIANTS.SELF_BAN]: "You cannot suspend your own account.",
  [ADMIN_INVARIANTS.SELF_DELETE]: "You cannot delete your own account here.",
  [ADMIN_INVARIANTS.SELF_IMPERSONATE]: "You are already signed in as yourself.",
  [ADMIN_INVARIANTS.LAST_ADMIN]:
    "This is the only administrator left. Give another account an admin role first.",
  [ADMIN_INVARIANTS.NOT_AN_ADMIN]:
    "Only an administrator can grant an admin role.",
}

/** Thrown by {@link assertAdminInvariants}; carries the code, not just prose. */
export class AdminInvariantError extends Error {
  readonly code: AdminInvariantCode

  constructor(code: AdminInvariantCode) {
    super(ADMIN_INVARIANT_MESSAGES[code])
    this.name = "AdminInvariantError"
    this.code = code
  }
}

/**
 * An admin account that could take over if this one went away.
 *
 * A suspended or not-yet-active admin is not a fallback: nobody can sign in as
 * them, so treating them as one is how a deployment ends up locked out while
 * the check says everything is fine.
 */
export function isUsableAdmin(
  user: AdminInvariantUser,
  adminRoles: readonly string[]
): boolean {
  if (!isAdmin(user.role, adminRoles)) return false
  if (
    user.status !== undefined &&
    user.status !== null &&
    user.status !== "active"
  ) {
    return false
  }
  return !isCurrentlyBanned(user)
}

function isCurrentlyBanned(user: AdminInvariantUser): boolean {
  if (!user.banned) return false
  // A lapsed temporary ban is not a ban; the gate chain lets these users in.
  if (user.banExpires && user.banExpires.getTime() <= Date.now()) return false
  return true
}

/**
 * Refuses the action, or returns.
 *
 * **The last-admin rule is checked before the self rules**, and that ordering
 * was wrong the first time. "You cannot change your own roles — ask another
 * administrator" is good advice right up until the administrator asking is the
 * only one, at which point it is advice that cannot be followed: there is
 * nobody to ask. And that is precisely the case a lone administrator hits,
 * because with two administrators the last-admin rule does not apply at all.
 *
 * So when both rules fit, the one that names something the person can actually
 * do — "give another account an admin role first" — wins. The self rules still
 * answer every case where a colleague does exist.
 */
export function assertAdminInvariants(input: AdminInvariantInput): void {
  const { actor, target, action, adminRoles, admins } = input
  const isSelf = actor.id === target.id

  if (removesAnAdmin(action, target, adminRoles)) {
    const remaining = admins.filter(
      (admin) => admin.id !== target.id && isUsableAdmin(admin, adminRoles)
    )
    if (remaining.length === 0) {
      throw new AdminInvariantError(ADMIN_INVARIANTS.LAST_ADMIN)
    }
  }

  if (isSelf) {
    switch (action.kind) {
      case "set-role":
        throw new AdminInvariantError(ADMIN_INVARIANTS.SELF_ROLE)
      case "ban":
      case "reject":
        throw new AdminInvariantError(ADMIN_INVARIANTS.SELF_BAN)
      case "delete":
        throw new AdminInvariantError(ADMIN_INVARIANTS.SELF_DELETE)
      case "impersonate":
        throw new AdminInvariantError(ADMIN_INVARIANTS.SELF_IMPERSONATE)
      default:
        break
    }
  }

  // FR-ROLE-3: granting admin is not something a non-admin can do. The endpoint
  // gate already refuses non-admins, so this catches the subtler case — an
  // actor whose admin role was taken away between the gate and the write.
  if (
    action.kind === "set-role" &&
    isAdmin(action.roles.join(","), adminRoles)
  ) {
    if (!isAdmin(actor.role, adminRoles)) {
      throw new AdminInvariantError(ADMIN_INVARIANTS.NOT_AN_ADMIN)
    }
  }
}

/** Whether the action would leave the target unable to administer. */
function removesAnAdmin(
  action: AdminAction,
  target: AdminInvariantUser,
  adminRoles: readonly string[]
): boolean {
  if (!isUsableAdmin(target, adminRoles)) return false

  switch (action.kind) {
    case "ban":
    case "delete":
    case "reject":
      return true
    case "set-role":
      // Only a demotion counts. Adding a second role to an admin is fine.
      return !isAdmin(action.roles.join(","), adminRoles)
    default:
      return false
  }
}
