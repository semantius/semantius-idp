/**
 * Keeping CORS and the CSP `form-action` list in step with the database
 * (**D50**, FR-OIDC-17, SEC-4, D46).
 *
 * `clientOrigins()` used to read the configuration file and nothing else, which
 * was correct while `oauth_clients.json` was the only way a client could exist.
 * It is not any more: an administrator can register one at `/admin/clients`,
 * and a client whose origin is missing from that set fails in a way that is
 * genuinely hard to attribute — the authorization succeeds, the token endpoint
 * is refused by CORS, and Chrome blocks the redirect back to the application
 * under `form-action`. Nothing in the logs says "origin".
 *
 * So the set is file clients ∪ **enabled** database clients, and this is what
 * puts the second half there. Disabled rows are excluded deliberately: a client
 * an administrator switched off should stop being an allowed origin, not merely
 * stop receiving tokens.
 *
 * Refreshed at start-up and after every client mutation. OPS-11 (single
 * instance) is what makes a process-local cache the right shape; the cost of
 * being wrong is bounded by a restart.
 */

import { eq } from "drizzle-orm"

import type { DbHandle } from "../db/client"
import { browserOriginsOf, setDatabaseClientOrigins } from "../http/cors"
import type { Logger } from "../logger"

/**
 * Re-reads every enabled client row and replaces the cached origin set.
 *
 * Never throws: this runs inside start-up and inside admin mutations, and a
 * failed refresh must not fail either. A stale set is a client that cannot
 * sign in until the next restart; a thrown error here would be a deployment
 * that does not start.
 */
export async function refreshDatabaseClientOrigins(
  database: DbHandle,
  logger?: Logger
): Promise<void> {
  try {
    const rows = await database.db
      .select({
        redirectUris: database.schema.oauthClient.redirectUris,
        postLogoutRedirectUris:
          database.schema.oauthClient.postLogoutRedirectUris,
      })
      .from(database.schema.oauthClient)
      .where(eq(database.schema.oauthClient.disabled, false))

    const origins = new Set<string>()
    for (const row of rows) {
      for (const origin of browserOriginsOf([
        ...row.redirectUris,
        ...(row.postLogoutRedirectUris ?? []),
      ])) {
        origins.add(origin)
      }
    }
    setDatabaseClientOrigins(origins)
  } catch (error) {
    logger?.error("could not refresh the client origin cache", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
