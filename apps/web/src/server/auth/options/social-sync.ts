/**
 * What a social identity is allowed to do to a local account (FR-SOC-2/3/4,
 * D24).
 *
 * `social.ts` decides which providers exist and what options they get. This
 * module is the enforcement half, and it hangs off `user.validateUserInfo` —
 * the one seam Better Auth 1.7.1 gives that sees the **fresh provider profile**
 * on `create-user`, `link-account` *and* a returning `sign-in`, before any row
 * is written and before a session exists. A `databaseHooks.user.update.before`
 * hook cannot do this job: it receives the changed columns and no user id, so
 * it cannot tell whose row is about to be overwritten.
 *
 * Two rules:
 *
 * - **FR-SOC-3, per provider.** `social.<p>.allowedEmailDomains` narrows who
 *   may arrive through that provider, on top of `signUp.allowedEmailDomains`.
 *   Checked on the way back *every* time, not only at registration: an account
 *   whose provider address has moved out of bounds should stop getting in.
 *
 * - **D24, the e-mail collision.** With `syncProfile` on, a provider that
 *   reports an address already held by a *different* local user would rewrite
 *   that user's identity — or, at best, blow up on the unique index. Instead
 *   the sign-in is refused with a neutral message (FR-SOC-2 wording: nothing
 *   about who owns the address), both rows are left untouched, no session is
 *   created, and the attempt is recorded as `social.profile_conflict`.
 */

import { eq } from "drizzle-orm"

import type { BetterAuthOptions } from "better-auth"

import type { Audit } from "../../audit"
import type { IdpConfig } from "../../config/derive"
import type { SocialProviderConfig } from "../../config/schema/config-schema"
import type { DbHandle } from "../../db/client"
import type { Logger } from "../../logger"
import { isEmailDomainAllowed, normalizeEmail } from "./social"

/** Error codes the callback surfaces; the wording comes from the catalog. */
export const SOCIAL_ERROR_CODES = {
  domainNotAllowed: "social_domain_not_allowed",
  emailConflict: "social_email_conflict",
} as const

export interface SocialSyncDeps {
  config: IdpConfig
  /** Absent during schema generation, which has no connection. */
  database?: DbHandle
  audit?: Audit
  logger?: Logger
}

/**
 * Whether an address may arrive through this provider.
 *
 * Pure, so the matrix of global list × per-provider list × neither is testable
 * without a database. An empty list means "no restriction" at that level, and
 * both levels have to say yes.
 */
export function isSocialEmailAllowed(
  config: IdpConfig,
  provider: SocialProviderConfig | undefined,
  email: string
): boolean {
  if (!isEmailDomainAllowed(email, config.file.signUp.allowedEmailDomains)) {
    return false
  }
  return isEmailDomainAllowed(email, provider?.allowedEmailDomains ?? [])
}

interface ProviderUserInfo {
  /**
   * On `sign-in` this is the **local** user id the provider identity is
   * already bound to (Better Auth substitutes it before calling the hook);
   * on `create-user` there is no local row yet and it is absent.
   */
  id?: unknown
  email?: unknown
}

interface ValidateSource {
  action: "create-user" | "link-account" | "sign-in"
  oauth?: { providerId: string } | undefined
}

/**
 * Builds the `user.validateUserInfo` option.
 *
 * Returning `{ error }` refuses the identity: browser flows land on the error
 * URL and no session is created. Returning nothing admits it.
 */
export function buildValidateUserInfo(
  deps: SocialSyncDeps
): NonNullable<BetterAuthOptions["user"]>["validateUserInfo"] {
  const { config } = deps

  return async (data, _context) => {
    const source = data.source as unknown as ValidateSource
    const providerId = source.oauth?.providerId
    // Password, admin and CLI identities are gated by the database hooks;
    // this is only about what a provider asserts.
    if (!providerId) return

    const info = data.user as ProviderUserInfo
    const email = normalizeEmail(String(info.email ?? ""))
    if (email === "") return

    const provider = config.file.social[providerId]

    if (!isSocialEmailAllowed(config, provider, email)) {
      return {
        error: SOCIAL_ERROR_CODES.domainNotAllowed,
        errorDescription: "This account cannot sign in with that provider.",
      }
    }

    // Only a profile sync can move an address onto an existing row; without
    // it Better Auth never touches `email`, so there is nothing to collide.
    if (source.action !== "sign-in") return
    if (provider?.syncProfile !== true) return

    const boundUserId = typeof info.id === "string" ? info.id : ""
    if (boundUserId === "") return

    const ownerUserId = await findAddressOwner(deps, email)
    if (ownerUserId === undefined || ownerUserId === boundUserId) return

    await deps.audit?.record({
      action: "social.profile_conflict",
      outcome: "failure",
      actorType: "anonymous",
      target: { type: "user", id: boundUserId },
      metadata: {
        providerId,
        // The colliding address. It is already in the trail for every other
        // event about that user, so this adds no new exposure.
        email,
        conflictingUserId: ownerUserId,
      },
    })

    return {
      error: SOCIAL_ERROR_CODES.emailConflict,
      // FR-SOC-2: neutral. Never "that address belongs to someone else".
      errorDescription: "This account cannot sign in with that provider.",
    }
  }
}

/**
 * Which user already holds `email`, or `undefined` when nobody does.
 *
 * Queried directly rather than through Better Auth's internal adapter, which
 * is not reachable from this hook's arguments.
 */
async function findAddressOwner(
  deps: SocialSyncDeps,
  email: string
): Promise<string | undefined> {
  const { database, logger } = deps
  if (!database) return undefined

  try {
    const [owner] = await database.db
      .select({ id: database.schema.user.id })
      .from(database.schema.user)
      .where(eq(database.schema.user.email, email))
      .limit(1)
    return owner?.id
  } catch (error) {
    // A failed lookup must not admit the identity: refusing is the safe
    // direction, so the caller is handed an owner it can never match.
    logger?.error("could not check for a social e-mail conflict", {
      error: error instanceof Error ? error.message : String(error),
    })
    return "unknown"
  }
}
