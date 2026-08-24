/**
 * Taking OAuth tokens away (FR-OIDC-12, FR-AUTH-3/6, FR-OIDC-10).
 *
 * Three call sites want three *different* scopes, and collapsing them into one
 * "revoke everything" would be wrong in two of the three:
 *
 * - **`revokeAllForUser`** — a password reset or change, a ban, a rejection, a
 *   deletion, or an administrator's explicit "sign this person out
 *   everywhere". The user's whole OAuth footprint goes.
 * - **`revokeForSession`** — `session.revokeOAuthTokensOnLogout`. FR-AUTH-6
 *   revokes the tokens *that session* obtained, not the user's: signing out on
 *   a laptop must not log the phone out of every connected application.
 * - **`revokeForClient`** — withdrawing consent. FR-OIDC-10 revokes *that
 *   client's* tokens; the other applications the user has connected are not
 *   part of that decision.
 *
 * Access tokens are deleted, refresh tokens are marked `revoked`. The
 * asymmetry is deliberate: an access token is short-lived and opaque to us
 * once issued, so the row exists only to answer introspection, while a revoked
 * refresh token's row is the evidence that lets reuse detection tell "revoked"
 * apart from "never existed" (FR-OIDC-8).
 *
 * A JWT access token already issued cannot be recalled — it verifies against
 * the JWKS until it expires. That is inherent to stateless verification and is
 * why `oauth.accessTokenTtl` defaults to fifteen minutes.
 */

import { and, eq, isNull } from "drizzle-orm"

import type { Audit } from "../audit"
import type { DbHandle } from "../db/client"

export interface RevokeDeps {
  database: DbHandle
  audit?: Audit
}

export interface RevokeResult {
  accessTokens: number
  refreshTokens: number
}

/** Everything the user holds, everywhere (FR-OIDC-12). */
export async function revokeAllForUser(
  deps: RevokeDeps,
  { userId, reason }: { userId: string; reason: string }
): Promise<RevokeResult> {
  const { oauthAccessToken, oauthRefreshToken } = deps.database.schema
  const result = await revoke(deps, {
    accessWhere: eq(oauthAccessToken.userId, userId),
    refreshWhere: eq(oauthRefreshToken.userId, userId),
  })
  await record(deps, { userId, reason, scope: "user", result })
  return result
}

/**
 * The tokens one session obtained (FR-AUTH-6).
 *
 * Scoped on `session_id`, which both token tables carry — and which is set to
 * `null` rather than cascading when a session row is deleted, so this has to
 * run *before* the session goes.
 */
export async function revokeForSession(
  deps: RevokeDeps,
  {
    sessionId,
    userId,
    reason,
  }: {
    sessionId: string
    userId?: string
    reason: string
  }
): Promise<RevokeResult> {
  const { oauthAccessToken, oauthRefreshToken } = deps.database.schema
  const result = await revoke(deps, {
    accessWhere: eq(oauthAccessToken.sessionId, sessionId),
    refreshWhere: eq(oauthRefreshToken.sessionId, sessionId),
  })
  await record(deps, { userId, reason, scope: "session", result, sessionId })
  return result
}

/** One client's tokens for one user (FR-OIDC-10). */
export async function revokeForClient(
  deps: RevokeDeps,
  {
    userId,
    clientId,
    reason,
  }: {
    userId: string
    clientId: string
    reason: string
  }
): Promise<RevokeResult> {
  const { oauthAccessToken, oauthRefreshToken } = deps.database.schema
  const result = await revoke(deps, {
    accessWhere: and(
      eq(oauthAccessToken.userId, userId),
      eq(oauthAccessToken.clientId, clientId)
    ),
    refreshWhere: and(
      eq(oauthRefreshToken.userId, userId),
      eq(oauthRefreshToken.clientId, clientId)
    ),
  })
  await record(deps, { userId, reason, scope: "client", result, clientId })
  return result
}

type Condition = ReturnType<typeof eq> | undefined

async function revoke(
  deps: RevokeDeps,
  where: { accessWhere: Condition; refreshWhere: Condition }
): Promise<RevokeResult> {
  const { oauthAccessToken, oauthRefreshToken } = deps.database.schema

  const access = await deps.database.db
    .delete(oauthAccessToken)
    .where(where.accessWhere)
    .returning({ id: oauthAccessToken.id })

  const refresh = await deps.database.db
    .update(oauthRefreshToken)
    .set({ revoked: new Date() })
    // Already-revoked rows are left alone so a second call reports zero
    // rather than re-stamping history.
    .where(and(where.refreshWhere, isNull(oauthRefreshToken.revoked)))
    .returning({ id: oauthRefreshToken.id })

  return { accessTokens: access.length, refreshTokens: refresh.length }
}

async function record(
  deps: RevokeDeps,
  event: {
    userId?: string
    reason: string
    scope: "user" | "session" | "client"
    result: RevokeResult
    sessionId?: string
    clientId?: string
  }
): Promise<void> {
  // Nothing revoked is not an event: a password change for someone who never
  // used an OAuth client would otherwise write a row every time.
  if (event.result.accessTokens === 0 && event.result.refreshTokens === 0) {
    return
  }
  await deps.audit?.record({
    action: "token.revoked",
    outcome: "success",
    actorType: "system",
    actorUserId: event.userId,
    ...(event.userId ? { target: { type: "user", id: event.userId } } : {}),
    metadata: {
      scope: event.scope,
      reason: event.reason,
      accessTokens: event.result.accessTokens,
      refreshTokens: event.result.refreshTokens,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.clientId ? { clientId: event.clientId } : {}),
    },
  })
}
