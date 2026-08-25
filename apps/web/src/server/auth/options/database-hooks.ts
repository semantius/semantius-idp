/**
 * Database hooks — the single enforcement point for the approval gate
 * (FR-SIGNUP-2), the domain restriction (FR-SIGNUP-3) and e-mail normalisation
 * (FR-AUTH-1).
 *
 * These run underneath every path that creates a user or a session: password
 * sign-up, social callback, admin create, and the internal paths the refresh
 * and API-key flows use. Putting the rules here rather than in each route is
 * what makes "a non-`active` user obtains no session on any path" checkable
 * instead of aspirational — a new sign-in route cannot forget to call it.
 *
 * The refresh-token and API-key paths re-check user state on every use as well
 * (FR-SIGNUP-2, FR-KEY-2); this is the gate that stops the session existing in
 * the first place.
 */

import { APIError } from "better-auth/api"
import { isNotNull } from "drizzle-orm"

import type { BetterAuthOptions } from "better-auth"

import type { Audit } from "../../audit"
import type { IdpConfig } from "../../config/derive"
import type { DbHandle } from "../../db/client"
import type { Mailer } from "../../email/mailer"
import { displayName } from "../../display-name"
import type { Logger } from "../../logger"
import { isAdmin } from "../../role-utils"
import {
  revokeAllForUser,
  revokeForSession,
} from "../../oidc/revoke-user-tokens"
import { isEmailDomainAllowed, normalizeEmail } from "./social"
import type { UserStatus } from "./user-fields"

/**
 * Endpoints where an administrator, the bootstrap step or the CLI creates a
 * user. Accounts made this way are pre-approved and skip the domain
 * restriction (FR-SIGNUP-2, FR-SIGNUP-3, FR-ADMIN-2).
 */
const ADMINISTRATIVE_CREATE_PATHS = new Set([
  "/admin/create-user",
  "/admin/update-user",
])

/** Error codes the UI maps to `/pending-approval`, `/banned` and the neutral refusal. */
export const GATE_ERROR_CODES = {
  pendingApproval: "ACCOUNT_PENDING_APPROVAL",
  rejected: "ACCOUNT_REJECTED",
  banned: "ACCOUNT_BANNED",
  domainNotAllowed: "EMAIL_DOMAIN_NOT_ALLOWED",
} as const

interface HookContext {
  path?: string
  /** Set by the bootstrap step and the CLI so they bypass the self-registration rules. */
  context?: { internalRequest?: boolean }
}

/**
 * Endpoints where the **user themselves** sets their password, which is what
 * ends a forced change (FR-AUTH-4).
 *
 * Deliberately a list rather than "any credential password write". An admin
 * assigning a temporary password (FR-ADMIN-2, M10) writes a password *and*
 * raises this same flag; clearing on every write would race that and undo it.
 */
const SELF_SERVICE_PASSWORD_PATHS = new Set([
  "/change-password",
  "/reset-password",
])

/**
 * Every endpoint that writes a credential password (FR-AUTH-3, FR-OIDC-12).
 *
 * A new password means the old one is no longer sufficient to reach the
 * account — so neither should anything minted with it be. Better Auth revokes
 * *sessions* itself (`revokeSessionsOnPasswordReset`, and
 * `revokeOtherSessions` on change), but OAuth access and refresh tokens
 * survive both, and a refresh token outliving a password reset is the whole
 * reason FR-OIDC-12 exists.
 *
 * This is the seam rather than `emailAndPassword.onPasswordReset` because that
 * callback fires for `/reset-password` only — and, in this codebase, only when
 * an e-mail transport is configured, so a degraded deployment would have
 * silently skipped revocation.
 */
const PASSWORD_WRITE_PATHS = new Set([
  "/change-password",
  "/reset-password",
  "/admin/set-user-password",
])

interface PasswordHookContext {
  path?: string
  context?: {
    internalAdapter?: {
      updateUser: (
        userId: string,
        data: Record<string, unknown>
      ) => Promise<unknown>
    }
  }
}

/**
 * Lets a user out of the forced password change once they have completed it.
 *
 * `account.update.after` is the seam because it fires only after the write
 * succeeded and carries the whole row — `providerId` and `userId` both. The
 * matching `before` hook receives only the changed columns (`{ password }`),
 * with no user to act on, so it cannot do this job.
 *
 * Without this the flag was set at bootstrap and cleared nowhere: changing
 * the password succeeded and the next sign-in interposed the very same page,
 * for ever. The bootstrap admin could never reach any destination at all.
 */
async function clearMustChangePassword(
  account: { providerId?: string; userId?: string },
  context: PasswordHookContext | null
): Promise<void> {
  if (!endsForcedPasswordChange(account.providerId, context?.path)) return
  if (!account.userId) return

  const adapter = context?.context?.internalAdapter
  if (!adapter) return
  await adapter.updateUser(account.userId, { mustChangePassword: false })
}

/**
 * The decision on its own, so the endpoint list is testable without a database.
 *
 * `path` is `undefined` whenever there is no request behind the write — the
 * bootstrap step, the CLI, and Better Auth's own `internalAdapter.updateAccount`
 * all reach the hook that way. None of them should end a forced change.
 */
export function endsForcedPasswordChange(
  providerId: string | undefined,
  path: string | undefined
): boolean {
  if (providerId !== "credential") return false
  if (!path) return false
  return SELF_SERVICE_PASSWORD_PATHS.has(path)
}

/**
 * Whether this account write set a password (FR-AUTH-3, FR-OIDC-12).
 *
 * Pure and exported for the same reason as {@link endsForcedPasswordChange}:
 * `account.update.after` also fires when Better Auth refreshes a social
 * provider's stored tokens, and the `after` hook receives the whole row rather
 * than the changed columns — so the endpoint is the only thing that can tell
 * a password write from any other account update.
 */
export function writesPassword(
  providerId: string | undefined,
  path: string | undefined
): boolean {
  if (providerId !== "credential") return false
  if (!path) return false
  return PASSWORD_WRITE_PATHS.has(path)
}

/** Whether this creation is administrative rather than a self-registration. */
function isAdministrativeCreate(context: HookContext | null): boolean {
  if (!context) return true // no request at all: bootstrap admin or CLI
  if (!context.path) return true
  return ADMINISTRATIVE_CREATE_PATHS.has(context.path)
}

export interface DatabaseHookDeps {
  config: IdpConfig
  /** Absent during schema generation, which needs no connection. */
  database?: DbHandle
  /** Absent in degraded mode (FR-MAIL-2); a disabled one sends nothing. */
  mailer?: Mailer
  logger?: Logger
  /** Writes the FR-OIDC-12 `token.revoked` trail. */
  audit?: Audit
}

/**
 * Kills the OAuth tokens a password used to back (FR-AUTH-3, FR-OIDC-12).
 *
 * Never allowed to fail the password change: the new password is already
 * written by the time this runs, and refusing the change because a revocation
 * query failed would leave the user unable to sign in with either password.
 * A failure is logged loudly instead, because it means live tokens outlived a
 * credential change.
 */
async function revokeTokensAfterPasswordWrite(
  deps: DatabaseHookDeps,
  account: { providerId?: string; userId?: string },
  path: string | undefined
): Promise<void> {
  if (!writesPassword(account.providerId, path)) return
  if (!account.userId || !deps.database) return

  try {
    await revokeAllForUser(
      { database: deps.database, audit: deps.audit },
      { userId: account.userId, reason: `password_write:${path}` }
    )
  } catch (error) {
    deps.logger?.error(
      "could not revoke OAuth tokens after a password change",
      {
        error: error instanceof Error ? error.message : String(error),
        userId: account.userId,
      }
    )
  }
}

/**
 * FR-SIGNUP-2: "an administrator is notified" when a self-registration lands
 * as pending.
 *
 * The template has existed since M4 and nothing ever called it, so approval
 * was a queue nobody was told about. Recipients are every **active** admin —
 * a pending or rejected admin cannot act on it, and a banned one should not.
 *
 * Never allowed to fail the sign-up: the account is already written by the
 * time this runs, and refusing the registration because an e-mail bounced
 * would be the wrong trade. Failures are logged and swallowed.
 */
async function notifyAdminsOfPendingSignUp(
  deps: DatabaseHookDeps,
  applicantEmail: string
): Promise<void> {
  const { config, database, mailer, logger } = deps
  if (!database || !mailer?.enabled) return

  try {
    const rows = await database.db
      .select({
        email: database.schema.user.email,
        role: database.schema.user.role,
        status: database.schema.user.status,
        banned: database.schema.user.banned,
      })
      .from(database.schema.user)
      // Narrows the scan to users who could possibly be admins; the catalog
      // check itself has to happen in JS, because several roles share one
      // comma-separated column (FR-ROLE-2).
      .where(isNotNull(database.schema.user.role))

    const recipients = rows
      .filter(
        (row) =>
          row.status === "active" &&
          !row.banned &&
          isAdmin(row.role, config.adminRoles)
      )
      .map((row) => row.email)

    for (const recipient of recipients) {
      await mailer.send("pendingSignUp", recipient, { applicantEmail })
    }
  } catch (error) {
    logger?.error("could not notify admins of a pending sign-up", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function buildDatabaseHooks(
  deps: DatabaseHookDeps
): BetterAuthOptions["databaseHooks"] {
  const { config } = deps
  return {
    account: {
      update: {
        // FR-AUTH-4's other half: the flag has to come *off* again.
        after: async (account, context) => {
          // `context` really is null when there is no request behind the
          // write — the bootstrap step and the CLI both reach this hook that
          // way — so the cast has to say so, or the optional chain below
          // looks unnecessary to the linter and gets removed.
          const hook = context as PasswordHookContext | null
          await clearMustChangePassword(account, hook)
          await revokeTokensAfterPasswordWrite(deps, account, hook?.path)
        },
      },
    },
    user: {
      create: {
        before: async (user, context) => {
          const administrative = isAdministrativeCreate(
            context as HookContext | null
          )

          // FR-AUTH-1: addresses are trimmed and lower-cased everywhere.
          const email = normalizeEmail(String(user.email))

          // FR-SIGNUP-3: self-registration only, admins bypass it.
          if (
            !administrative &&
            !isEmailDomainAllowed(email, config.file.signUp.allowedEmailDomains)
          ) {
            throw new APIError("BAD_REQUEST", {
              code: GATE_ERROR_CODES.domainNotAllowed,
              message: "Registration is not open to this e-mail domain.",
            })
          }

          // FR-SIGNUP-2: admin-created and bootstrap users are active
          // immediately; self-registrations wait for approval when it is on.
          const status: UserStatus = administrative
            ? "active"
            : config.file.signUp.requireApproval
              ? "pending"
              : "active"

          // FR-SIGNUP-5 / D49: `name` falls back to the two parts, composed
          // in `site.nameFormat` order — the same helper every caller uses,
          // so a fallback and an explicit derivation cannot disagree.
          const first =
            typeof user.firstName === "string" ? user.firstName.trim() : ""
          const last =
            typeof user.lastName === "string" ? user.lastName.trim() : ""
          const name =
            typeof user.name === "string" && user.name.trim() !== ""
              ? user.name
              : displayName(first, last, config.file.site.nameFormat)

          return {
            data: {
              ...user,
              email,
              name,
              status,
              ...(status === "active" && administrative
                ? { approvedAt: new Date(), approvedBy: "system" }
                : {}),
            },
          }
        },
        after: async (user, context) => {
          // Only a self-registration that actually landed pending: an
          // admin-created user is already active and nobody is waiting on it.
          if (user.status !== "pending") return
          if (isAdministrativeCreate(context as HookContext | null)) return
          await notifyAdminsOfPendingSignUp(deps, String(user.email))
        },
      },
    },

    session: {
      delete: {
        /**
         * FR-AUTH-6: `session.revokeOAuthTokensOnLogout`.
         *
         * Scoped to the session, not the user — signing out on a laptop must
         * not log the phone out of every connected application. It has to run
         * *before* the row goes: both token tables reference `session_id` with
         * `on delete set null`, so after the delete there is nothing left to
         * scope on.
         */
        before: async (session) => {
          if (!config.file.session.revokeOAuthTokensOnLogout) return
          if (!deps.database) return
          try {
            await revokeForSession(
              { database: deps.database, audit: deps.audit },
              {
                sessionId: String(session.id),
                userId: String(session.userId),
                reason: "logout",
              }
            )
          } catch (error) {
            deps.logger?.error("could not revoke OAuth tokens on logout", {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        },
      },
      create: {
        before: async (session, context) => {
          // The gate: no session for anyone who is not `active` or is banned.
          const adapter = (
            context as { context?: { internalAdapter?: unknown } } | null
          )?.context
          const user = await findUser(adapter, String(session.userId))
          if (!user) return

          assertUserMaySignIn(user)
          return
        },
      },
    },
  }
}

export interface GateUser {
  status?: string | null
  banned?: boolean | null
  banExpires?: Date | string | null
}

/**
 * Throws unless the user may hold a session right now.
 *
 * Shared with the refresh-token and API-key paths, which re-check state on
 * every use (FR-SIGNUP-2, FR-KEY-2, FR-OIDC-12) — the same rules have to give
 * the same answer wherever they are asked.
 */
export function assertUserMaySignIn(user: GateUser): void {
  if (user.banned === true && !banHasExpired(user.banExpires)) {
    throw new APIError("FORBIDDEN", {
      code: GATE_ERROR_CODES.banned,
      message: "This account is not available.",
    })
  }

  const status = user.status ?? "pending"
  if (status === "pending") {
    throw new APIError("FORBIDDEN", {
      code: GATE_ERROR_CODES.pendingApproval,
      message: "This account is awaiting approval.",
    })
  }
  if (status === "rejected") {
    // SEC-7: the same neutral refusal a banned or unknown account gets.
    throw new APIError("FORBIDDEN", {
      code: GATE_ERROR_CODES.rejected,
      message: "This account is not available.",
    })
  }
}

function banHasExpired(banExpires: Date | string | null | undefined): boolean {
  if (!banExpires) return false // no expiry = permanent
  const expiry = banExpires instanceof Date ? banExpires : new Date(banExpires)
  return Number.isFinite(expiry.getTime()) && expiry.getTime() <= Date.now()
}

interface MaybeInternalAdapter {
  internalAdapter?: {
    findUserById?: (id: string) => Promise<GateUser | null>
  }
}

async function findUser(
  adapter: unknown,
  userId: string
): Promise<GateUser | undefined> {
  const internalAdapter = (adapter as MaybeInternalAdapter | undefined)
    ?.internalAdapter
  if (!internalAdapter?.findUserById) return undefined
  return (await internalAdapter.findUserById(userId)) ?? undefined
}
