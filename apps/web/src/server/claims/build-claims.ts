/**
 * The one place a token learns anything about a user (FR-OIDC-7).
 *
 * Three different tokens carry user claims — the OAuth access token, the ID
 * token, and the session JWT that `GET {baseUrl}/api/auth/token` mints from a
 * session or an API key — and FR-OIDC-7's acceptance criterion is that their
 * shapes are identical modulo `sub`, `sid`, `azp` and `scope`. One builder is
 * how that is true by construction rather than by three implementations
 * happening to agree this week.
 *
 * **What is deliberately not here.** The provider emits `sub`, `aud`,
 * `client_id`, `azp`, `scope`, `sid`, `iss`, `iat`, `exp` and `jti` itself, and
 * spreads custom claims *first* so they cannot override those (spike S5 §2). A
 * builder that also emitted them would be writing values that are silently
 * discarded, which is worse than not writing them.
 *
 * **Roles are catalog-filtered** (FR-ROLE-2): a role that has been removed from
 * `roles.jsonc` stops appearing in tokens, even though the column still holds
 * it. The drop is the point — a resource server authorizing on a role the
 * deployment no longer defines is exactly the situation the catalog exists to
 * prevent.
 */

import type { IdpConfig } from "../config/derive"
import type { UserClaimName } from "../config/schema/config-schema"
import { effectiveRoles } from "../role-utils"

/** The subset of a user row the builder reads. */
export interface ClaimsUser {
  email?: unknown
  name?: unknown
  firstName?: unknown
  lastName?: unknown
  /** The stored, comma-separated column (FR-ROLE-2). */
  role?: unknown
}

export type Claims = Record<string, unknown>

/**
 * The user claims for one token.
 *
 * With `jwt.includeUserData: false` this is the static `jwt.claims` and
 * nothing else — a deployment that wants tokens carrying no personal data at
 * all gets exactly that, including no `roles`.
 */
export function buildUserClaims(
  user: ClaimsUser | null | undefined,
  config: IdpConfig
): Claims {
  // Static claims first, so a deployment cannot accidentally shadow a user
  // claim with a constant and quietly break authorization downstream.
  const claims: Claims = { ...config.file.jwt.claims }

  if (!user) return claims

  for (const claim of config.userClaims) {
    const value = valueFor(claim, user, config)
    if (value !== undefined) claims[claim] = value
  }

  return claims
}

function valueFor(
  claim: UserClaimName,
  user: ClaimsUser,
  config: IdpConfig
): unknown {
  switch (claim) {
    case "email":
      return text(user.email)
    case "name":
      return text(user.name)
    case "given_name":
      return text(user.firstName)
    case "family_name":
      return text(user.lastName)
    case "roles": {
      // Always present when asked for, even when empty: a resource server
      // reading `roles` should see `[]` rather than have to distinguish
      // "no roles" from "this IdP does not send roles".
      return effectiveRoles(text(user.role), config.roles)
    }
  }
}

/** Empty strings are absent values, not claims worth emitting. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}
