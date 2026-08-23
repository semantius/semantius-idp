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

import type { BetterAuthOptions } from "better-auth"

import type { IdpConfig } from "../../config/derive"
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

/** Whether this creation is administrative rather than a self-registration. */
function isAdministrativeCreate(context: HookContext | null): boolean {
  if (!context) return true // no request at all: bootstrap admin or CLI
  if (!context.path) return true
  return ADMINISTRATIVE_CREATE_PATHS.has(context.path)
}

export function buildDatabaseHooks(
  config: IdpConfig
): BetterAuthOptions["databaseHooks"] {
  return {
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

          // FR-SIGNUP-5: `name` falls back to "firstName lastName".
          const first =
            typeof user.firstName === "string" ? user.firstName.trim() : ""
          const last =
            typeof user.lastName === "string" ? user.lastName.trim() : ""
          const composed = [first, last].filter(Boolean).join(" ")
          const name =
            typeof user.name === "string" && user.name.trim() !== ""
              ? user.name
              : composed

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
      },
    },

    session: {
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

interface GateUser {
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
