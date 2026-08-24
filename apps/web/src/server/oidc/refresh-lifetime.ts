/**
 * The 90-day ceiling on a 30-day sliding refresh token (FR-OIDC-13).
 *
 * "Refresh token 30 d sliding with 90 d absolute maximum." The sliding half is
 * the provider's: every rotation issues a new token expiring
 * `oauth.refreshTokenTtl` from now. The absolute half has no option in 1.7.1 —
 * `refreshTokenExpiresIn` and `refreshTokenReuseInterval` are the only
 * lifetime knobs — so without this a client that refreshes once a week holds a
 * valid refresh token for ever, and the ceiling exists precisely so that it
 * cannot.
 *
 * **Where the ceiling is measured from.** Rotation carries
 * `authorizationCodeId` forward, so every token descended from one
 * authorization shares it: the family's origin is the earliest `createdAt`
 * among rows with that id. A family that started more than
 * `oauth.refreshTokenMaxLifetime` ago is revoked outright — the user has to
 * authorize again, which is what an absolute maximum means.
 *
 * **When it runs.** Immediately before a refresh grant, and only then. Doing
 * it at issuance would mean clamping an expiry the provider is about to
 * overwrite on the next rotation; doing it on a timer would leave a window
 * where an over-age token still works. Revoking first means the presented
 * token is already dead by the time the grant looks at it, and the client
 * gets the ordinary `invalid_grant` rather than a bespoke error.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm"

import type { IdpConfig } from "../config/derive"
import type { DbHandle } from "../db/client"
import type { Logger } from "../logger"

export interface RefreshLifetimeDeps {
  config: IdpConfig
  database?: DbHandle
  logger?: Logger
}

/**
 * Revokes every refresh-token family that has outlived the absolute maximum.
 *
 * Returns the number of tokens revoked, which is what the test asserts on.
 */
export async function revokeExpiredRefreshFamilies(
  deps: RefreshLifetimeDeps
): Promise<number> {
  const { config, database, logger } = deps
  if (!database) return 0

  const maxLifetime = config.file.oauth.refreshTokenMaxLifetime
  const cutoff = new Date(Date.now() - maxLifetime * 1000)
  const { oauthRefreshToken } = database.schema

  try {
    // The families whose *first* token predates the cutoff. Grouping is the
    // whole point: a rotated token created this morning is still part of a
    // family that began three months ago.
    //
    // The comparison is done here rather than in a `having` clause: the
    // aggregate is over a `timestamp` column and the cutoff is a JS `Date`,
    // and pushing that binding through Drizzle's `sql` template silently
    // matched nothing. One row per family is a small enough result to filter
    // in JavaScript, and it is obviously right.
    const families = await database.db
      .select({
        familyId: oauthRefreshToken.authorizationCodeId,
        origin: sql<Date>`min(${oauthRefreshToken.createdAt})`,
      })
      .from(oauthRefreshToken)
      .where(isNull(oauthRefreshToken.revoked))
      .groupBy(oauthRefreshToken.authorizationCodeId)

    const familyIds = families
      .filter((row) => new Date(row.origin).getTime() < cutoff.getTime())
      .map((row) => row.familyId)
      .filter((id): id is string => typeof id === "string")
    if (familyIds.length === 0) return 0

    const revoked = await database.db
      .update(oauthRefreshToken)
      .set({ revoked: new Date() })
      .where(
        and(
          isNull(oauthRefreshToken.revoked),
          inArray(oauthRefreshToken.authorizationCodeId, familyIds)
        )
      )
      .returning({ id: oauthRefreshToken.id })

    if (revoked.length > 0) {
      logger?.info("refresh families past their absolute lifetime revoked", {
        families: familyIds.length,
        tokens: revoked.length,
      })
    }
    return revoked.length
  } catch (error) {
    // Never fails the request: the grant itself is still subject to every
    // other check, and refusing a refresh because a housekeeping query failed
    // would take working clients down.
    logger?.error("could not enforce the refresh-token absolute lifetime", {
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}

/** Exported for the test that needs to age a family without waiting 90 days. */
export async function backdateFamily(
  database: DbHandle,
  familyId: string,
  createdAt: Date
): Promise<void> {
  const { oauthRefreshToken } = database.schema
  await database.db
    .update(oauthRefreshToken)
    .set({ createdAt })
    .where(eq(oauthRefreshToken.authorizationCodeId, familyId))
}
