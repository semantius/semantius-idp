/**
 * Who may call an administrative endpoint (FR-ROLE-3, FR-ADMIN-6).
 *
 * One middleware, used by every endpoint this app adds, so a new endpoint
 * cannot forget the check — and enforced against `admin.adminRoles` from the
 * configuration rather than a hard-coded name, because the catalog decides who
 * is an administrator.
 *
 * It is deliberately *not* used to wrap Better Auth's own admin endpoints:
 * those already carry the plugin's equivalent, and a second gate in front of
 * them would be a second thing to keep in step with `adminRoles`.
 */

import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api"

import type { IdpConfig } from "../config/derive"
import { splitRoles } from "../role-utils"

export const NOT_AN_ADMIN = "You do not have access to this."

export function requireAdmin(config: IdpConfig) {
  const adminRoles = new Set(config.adminRoles)
  return createAuthMiddleware(async (ctx) => {
    const session = await resolveSession(ctx)
    if (!session?.user) {
      throw new APIError("UNAUTHORIZED", { message: NOT_AN_ADMIN })
    }
    const roles = splitRoles((session.user as { role?: string | null }).role)
    if (!roles.some((role) => adminRoles.has(role))) {
      // Same wording an anonymous caller gets: the endpoint's existence is not
      // a secret, but who holds admin is not confirmed either.
      throw new APIError("FORBIDDEN", { message: NOT_AN_ADMIN })
    }
    return { session }
  })
}

/**
 * The caller, whether they arrived with a cookie or an API key (FR-ADMIN-6).
 *
 * `getAuthoritativeSessionFromCtx` re-reads the session *row* past the cookie
 * cache, which is what an admin endpoint needs: a role change or a revocation
 * has to bite now, not whenever the ≤ 5 min cache of FR-AUTH-5 expires.
 *
 * But it does that by setting `ctx.context.session = null` and reading the
 * cookie again — and an API-key caller has no cookie. The api-key plugin built
 * their session in a `before` hook, so the authoritative read discards it and
 * answers 401, which made the whole admin API unreachable to exactly the
 * callers FR-ADMIN-6 exists for. Found by `integration/admin.test.ts`.
 *
 * So: try authoritative first, and fall back to whatever the hooks already
 * resolved — putting it back where the authoritative read nulled it, or every
 * later hook in the chain sees an anonymous request.
 *
 * The key-built session is not the stale one of the two. `gateApiKeyPlugin`
 * re-reads the owner's standing on *every* use (FR-KEY-2), so a banned owner's
 * key stops working immediately — sooner than a cookie session would.
 */
async function resolveSession(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]
) {
  const preset = ctx.context.session
  const authoritative = await getAuthoritativeSessionFromCtx(ctx)
  if (authoritative) return authoritative
  ctx.context.session = preset
  return preset
}
