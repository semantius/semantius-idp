/**
 * Name → gateway row, without a database query on the hot path (FR-GW-3,
 * **D91**).
 *
 * The proxy resolves a name on every request, and against a hosted Postgres
 * that is **~100 ms** before a byte has been forwarded — the same latency
 * AGENTS.md records for the integration suite. The whole table is small by
 * construction (it is a list an operator typed), so one query loads all of it
 * into a `Map` and the proxy reads memory.
 *
 * Three things keep the map honest, and they are in order of how much they
 * matter:
 *
 * 1. **Write-through invalidation.** Every admin mutation and the boot
 *    reconcile call {@link resetGatewayRegistry}. That is the mechanism, and
 *    it is exact: OPS-11 is a single-instance topology, so the process that
 *    wrote the row is the process that serves the next request. The
 *    `first-user.ts` memoization is the precedent.
 * 2. **A 60 s TTL**, as a valve for the replica that is not supposed to exist
 *    and sometimes does — an accidental second container, or a row changed
 *    with `psql`. Without it such a change would never be picked up.
 * 3. **Stale-while-revalidate**, which is what stops (2) from costing a
 *    request 100 ms every minute: an expired map is *served immediately* and
 *    one guarded in-flight promise refreshes it behind the request. Concurrent
 *    expiries share that one load rather than starting a load each.
 *
 * A cold map is the only case that waits, because there is nothing to serve.
 */

import { asc } from "drizzle-orm"

import type { DbHandle } from "../db/client"
import type { Logger } from "../logger"

export interface GatewayRow {
  id: string
  name: string
  url: string
  requireAuth: boolean
  /** Forward the edge's `X-Forwarded-*` rather than this hop's (**D92**). */
  trustProxy: boolean
  source: "config" | "manual"
  enabled: boolean
}

/** How long a loaded map is served without asking the database again. */
export const REGISTRY_TTL_MS = 60_000

interface RegistryState {
  entries: Map<string, GatewayRow>
  loadedAt: number
}

let state: RegistryState | undefined
/** The single in-flight load, shared by every caller that arrives during it. */
let inFlight: Promise<RegistryState> | undefined

export interface RegistryDeps {
  database: DbHandle
  logger?: Logger
  now?: () => number
}

/**
 * The gateway named `name`, or `undefined`.
 *
 * Disabled rows are returned rather than hidden: FR-GW-6 answers 404 for both
 * "no such gateway" and "disabled", and the caller is the one place that
 * decision belongs.
 */
export async function lookupGateway(
  deps: RegistryDeps,
  name: string
): Promise<GatewayRow | undefined> {
  const entries = await gatewayRegistry(deps)
  return entries.get(name)
}

export async function gatewayRegistry(
  deps: RegistryDeps
): Promise<ReadonlyMap<string, GatewayRow>> {
  const now = deps.now ?? Date.now
  const current = state

  if (current === undefined) return (await load(deps)).entries

  if (now() - current.loadedAt >= REGISTRY_TTL_MS) {
    // Stale-while-revalidate: hand back what we have and refresh behind the
    // request. `void` rather than `await` is the whole point — the alternative
    // is one request a minute paying for a round trip it did not cause.
    void load(deps).catch(() => undefined)
  }
  return current.entries
}

function load(deps: RegistryDeps): Promise<RegistryState> {
  // One promise for every concurrent caller. Without this a burst arriving on
  // a cold map is one query per request.
  inFlight ??= readAll(deps)
    .then((entries) => {
      const next: RegistryState = {
        entries,
        loadedAt: (deps.now ?? Date.now)(),
      }
      state = next
      return next
    })
    .catch((error: unknown) => {
      // A failed refresh must not poison the next attempt, and must not throw
      // away a map that is still serving requests.
      deps.logger?.warn("could not load the gateway registry", {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    })
    .finally(() => {
      inFlight = undefined
    })
  return inFlight
}

async function readAll(deps: RegistryDeps): Promise<Map<string, GatewayRow>> {
  const { db, schema } = deps.database
  const rows = await db
    .select()
    .from(schema.gateway)
    .orderBy(asc(schema.gateway.name))
  return new Map(rows.map((row) => [row.name, toGatewayRow(row)]))
}

/** The stored row, with the nullable columns resolved to their defaults. */
export function toGatewayRow(row: {
  id: string
  name: string
  url: string
  requireAuth: boolean | null
  trustProxy: boolean | null
  source: string
  enabled: boolean | null
}): GatewayRow {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    requireAuth: row.requireAuth === true,
    trustProxy: row.trustProxy === true,
    source: row.source === "config" ? "config" : "manual",
    enabled: row.enabled !== false,
  }
}

/**
 * Drops the cached map.
 *
 * Called by the boot reconcile and by every admin gateway mutation, so a
 * change made through this process is visible on the very next request rather
 * than up to a minute later. Exported for tests, which is the only reason it
 * also clears the in-flight promise.
 */
export function resetGatewayRegistry(): void {
  state = undefined
  inFlight = undefined
}
