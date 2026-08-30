/**
 * What an account is actually connected to (FR-OIDC-10, FR-ACCT-1, **D102**).
 *
 * `/account/consents` used to list the `oauth_consent` table and nothing else,
 * which in this deployment is a list of nothing: file clients default to
 * `skipConsent: true` — the administrator configured them, so the user is not
 * asked — and a skipped consent writes no row. The page was therefore
 * permanently empty however many applications the user had signed in to, and
 * the Disconnect button behind it was unreachable code.
 *
 * A grant is really *either* of two durable things, and the union is what the
 * user means by "connected":
 *
 * - a stored **consent** — the user was asked and said yes; the row records
 *   which scopes and when;
 * - a live **refresh token** — the application can obtain new access tokens
 *   without the user being present, which is the thing worth being able to
 *   take away.
 *
 * **A client with neither is legitimately absent.** A `skipConsent` client
 * that never asked for `offline_access` leaves no row anywhere: its access
 * token is a stateless JWT (FR-OIDC-5) and its ability to act ends when that
 * token expires, fifteen minutes by default. There is nothing to revoke and
 * nothing to list, and the page says so rather than implying the list is
 * complete.
 *
 * **The live filter is not optional.** A revoked refresh token's row survives
 * `oauth.tokenGraceDays` (30) so reuse detection can tell "revoked" from
 * "never existed" (FR-OIDC-8), and an expired one survives the same sweep. A
 * grants list that read the table raw would resurrect a month of applications
 * the user had already disconnected — and offer to disconnect them again.
 *
 * Plain functions rather than server functions: they take a handle, so the
 * integration suite can call them against its own schema, and they stay under
 * the `src/server/oidc/**` coverage gate.
 */

import { and, eq, gt, isNull } from "drizzle-orm"

import type { DbHandle } from "../db/client"

export interface ActiveGrant {
  clientId: string
  /** The registered display name, falling back to the id. */
  clientName: string
  scopes: string[]
  connectedAt: Date
  /** Whether the user was actually asked (a `skipConsent` client was not). */
  hasConsent: boolean
  /** Live refresh tokens behind the grant; `0` for a consent-only row. */
  activeTokens: number
}

/**
 * Every client this user is connected to, most recent first.
 *
 * `now` is injectable so a test can assert the expiry boundary without
 * sleeping.
 */
export async function activeGrantsFor(
  database: DbHandle,
  userId: string,
  now: Date = new Date()
): Promise<ActiveGrant[]> {
  const { oauthConsent, oauthClient, oauthRefreshToken } = database.schema

  const consents = await database.db
    .select({
      clientId: oauthConsent.clientId,
      scopes: oauthConsent.scopes,
      createdAt: oauthConsent.createdAt,
      clientName: oauthClient.name,
    })
    .from(oauthConsent)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, userId))

  const tokens = await database.db
    .select({
      clientId: oauthRefreshToken.clientId,
      scopes: oauthRefreshToken.scopes,
      createdAt: oauthRefreshToken.createdAt,
      authTime: oauthRefreshToken.authTime,
      clientName: oauthClient.name,
    })
    .from(oauthRefreshToken)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthRefreshToken.clientId))
    .where(liveTokensFor(database, userId, now))

  const grants = new Map<string, ActiveGrant>()

  for (const row of consents) {
    grants.set(row.clientId, {
      clientId: row.clientId,
      // A client the reconciler has since removed still has a grant to
      // withdraw, so the id is a usable name of last resort (`account.ts`
      // makes the same trade for the same reason).
      clientName: row.clientName ?? row.clientId,
      scopes: [...row.scopes],
      connectedAt: row.createdAt,
      hasConsent: true,
      activeTokens: 0,
    })
  }

  for (const row of tokens) {
    const existing = grants.get(row.clientId)
    if (existing?.hasConsent) {
      // The consent row wins the display: its scopes are what the user was
      // shown and agreed to, and its date is when they agreed. The token only
      // adds to the count.
      existing.activeTokens += 1
      continue
    }
    // No consent row: the union of what the live tokens actually carry, and
    // the earliest of their `auth_time`s. `auth_time` rather than
    // `created_at` because rotation writes a *new* row on every refresh and
    // carries `auth_time` across — dating the grant by the row would walk it
    // forward every fifteen minutes and report a year-old connection as new.
    const connectedAt = row.authTime ?? row.createdAt
    if (existing) {
      for (const scope of row.scopes) {
        if (!existing.scopes.includes(scope)) existing.scopes.push(scope)
      }
      if (connectedAt < existing.connectedAt) existing.connectedAt = connectedAt
      existing.activeTokens += 1
      continue
    }
    grants.set(row.clientId, {
      clientId: row.clientId,
      clientName: row.clientName ?? row.clientId,
      scopes: [...row.scopes],
      connectedAt,
      hasConsent: false,
      activeTokens: 1,
    })
  }

  return [...grants.values()].sort(
    (left, right) => right.connectedAt.getTime() - left.connectedAt.getTime()
  )
}

/**
 * Which applications signed in through which session, by session id.
 *
 * The names only — never a token, never a scope. `/account/sessions` renders
 * them so "sign this one out" can say what it is about to disconnect, and that
 * page's standing rule is that no token material reaches the document.
 *
 * A token whose minting session is already gone (`session_id` is set to
 * `null`, not cascaded, when a session row is deleted) belongs to no row here.
 */
export async function liveTokenClientsBySession(
  database: DbHandle,
  userId: string,
  now: Date = new Date()
): Promise<Map<string, string[]>> {
  const { oauthClient, oauthRefreshToken } = database.schema

  const rows = await database.db
    .select({
      sessionId: oauthRefreshToken.sessionId,
      clientId: oauthRefreshToken.clientId,
      clientName: oauthClient.name,
    })
    .from(oauthRefreshToken)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthRefreshToken.clientId))
    .where(liveTokensFor(database, userId, now))

  const bySession = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.sessionId === null) continue
    const names = bySession.get(row.sessionId) ?? new Set<string>()
    names.add(row.clientName ?? row.clientId)
    bySession.set(row.sessionId, names)
  }

  // Sorted so the server's markup and the client's agree: a `Set`'s insertion
  // order is whatever the query planner handed back, and two renders of the
  // same data must not differ.
  return new Map(
    [...bySession].map(([sessionId, names]) => [sessionId, [...names].sort()])
  )
}

/** The one predicate both reads share: this user's, not revoked, not expired. */
function liveTokensFor(database: DbHandle, userId: string, now: Date) {
  const { oauthRefreshToken } = database.schema
  return and(
    eq(oauthRefreshToken.userId, userId),
    isNull(oauthRefreshToken.revoked),
    gt(oauthRefreshToken.expiresAt, now)
  )
}
