/**
 * `oauth_clients.json` is the source of truth; this makes the database agree
 * (FR-OIDC-2, OPS-2).
 *
 * The file is edited, the container restarts, and the rows follow. That only
 * works if the sync is total — a client removed from the file has to *stop
 * working*, not linger because nobody deleted it. So absence is a decision, not
 * an omission: the row is disabled and its tokens revoked, or deleted outright
 * when `oauth.reconcile.prune` says so.
 *
 * **The sweep is scoped to file-managed rows** (`userId === null`), which is
 * what lets D50's admin-registered clients coexist with these: a row with an
 * owner is not an orphan, and no restart touches it. That scoping predates
 * D50 — it is what made D50 cheap.
 *
 * **Everything in one transaction, under one advisory lock, on the direct
 * connection.** Two containers starting together would otherwise both compute
 * a diff from the same before-state and apply it twice; a session-level lock
 * does not hold through a transaction pooler, which is why this takes the
 * direct handle (D27, S4). The transaction is what stops a crash halfway
 * through leaving a client with new redirect URIs and a stale secret.
 *
 * The secret is re-hashed **only when it changed**, so an unchanged file makes
 * no writes at all and `createdAt` survives every restart. That matters more
 * than it sounds: a reconcile that rewrote every row on every boot would fill
 * the audit trail with `client.reconciled` events that mean nothing, and the
 * "idempotent re-run" test is what holds the line.
 */

import { and, eq, inArray } from "drizzle-orm"

import type { Audit } from "../audit"
import type { IdpConfig } from "../config/derive"
import { LOCK_KEYS, withAdvisoryLock } from "../db/advisory-lock"
import type { DbHandle } from "../db/client"
import type { Logger } from "../logger"
import { resourceLinksFor, toClientRow } from "./client-mapping"
import type { ClientRow } from "./client-mapping"
import { hashClientSecret } from "./secret-hash"

export interface ReconcileDeps {
  config: IdpConfig
  /** Request traffic's handle: reads and the transaction itself. */
  database: DbHandle
  /** The **direct** connection, for the advisory lock (D27). */
  locking: DbHandle
  audit?: Audit
  logger?: Logger
}

/** What changed, for the log, the audit row and `/admin/system`. */
export interface ReconcileDiff {
  created: string[]
  updated: string[]
  /** Present in the database, absent from the file: disabled, or pruned. */
  disabled: string[]
  deleted: string[]
  /** Client ids whose resource links changed. */
  relinked: string[]
  /** True when nothing at all had to be written. */
  unchanged: boolean
}

const EMPTY_DIFF: ReconcileDiff = {
  created: [],
  updated: [],
  disabled: [],
  deleted: [],
  relinked: [],
  unchanged: true,
}

export async function reconcileClients(
  deps: ReconcileDeps
): Promise<ReconcileDiff> {
  const { locking } = deps

  return withAdvisoryLock(
    locking.sql,
    "reconcileClients",
    async () => applyReconciliation(deps),
    { timeoutSeconds: 60 }
  ).then((result) => result ?? EMPTY_DIFF)
}

/** Exported for the test that runs two reconciles concurrently. */
export const RECONCILE_LOCK = LOCK_KEYS.reconcileClients

async function applyReconciliation(
  deps: ReconcileDeps
): Promise<ReconcileDiff> {
  const { config, database, audit, logger } = deps
  const schema = database.schema
  const entries = config.clients
  const wantedIds = entries.map((entry) => entry.clientId)

  const diff: ReconcileDiff = {
    created: [],
    updated: [],
    disabled: [],
    deleted: [],
    relinked: [],
    unchanged: true,
  }

  await database.db.transaction(async (tx) => {
    const existing = await tx.select().from(schema.oauthClient)
    const byId = new Map(existing.map((row) => [row.clientId, row]))

    for (const entry of entries) {
      const current = byId.get(entry.clientId)
      const desired = toClientRow(entry, {
        // Deterministic, so an unchanged secret produces the identical hash
        // and `differs` sees no change — which is what keeps a restart from
        // rewriting every row and filling the trail with empty events.
        hashedSecret: entry.clientSecret
          ? hashClientSecret(entry.clientSecret)
          : undefined,
      })

      if (!current) {
        await tx.insert(schema.oauthClient).values({
          id: crypto.randomUUID(),
          ...desired,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        diff.created.push(entry.clientId)
        continue
      }

      if (differs(current, desired)) {
        await tx
          .update(schema.oauthClient)
          // `createdAt` is deliberately absent: it records when the client was
          // first registered, not when it was last edited.
          .set({ ...desired, updatedAt: new Date() })
          .where(eq(schema.oauthClient.clientId, entry.clientId))
        diff.updated.push(entry.clientId)
      }
    }

    // -- absent from the file (FR-OIDC-2) ---------------------------------
    const orphans = existing.filter(
      (row) => !wantedIds.includes(row.clientId) && row.userId === null
    )
    for (const orphan of orphans) {
      await revokeTokensFor(tx, schema, orphan.clientId)
      if (config.file.oauth.reconcile.prune) {
        await tx
          .delete(schema.oauthClient)
          .where(eq(schema.oauthClient.clientId, orphan.clientId))
        diff.deleted.push(orphan.clientId)
      } else if (orphan.disabled !== true) {
        await tx
          .update(schema.oauthClient)
          .set({ disabled: true, updatedAt: new Date() })
          .where(eq(schema.oauthClient.clientId, orphan.clientId))
        diff.disabled.push(orphan.clientId)
      } else {
        // Already disabled on an earlier run; revoking again is a no-op and
        // must not be reported as a change.
        continue
      }
    }

    // -- resource links (FR-OIDC-6) ---------------------------------------
    for (const entry of entries) {
      const wanted = resourceLinksFor(entry, config)
      const changed = await syncResourceLinks(
        tx,
        schema,
        entry.clientId,
        wanted
      )
      if (changed) diff.relinked.push(entry.clientId)
    }
  })

  diff.unchanged =
    diff.created.length === 0 &&
    diff.updated.length === 0 &&
    diff.disabled.length === 0 &&
    diff.deleted.length === 0 &&
    diff.relinked.length === 0

  if (!diff.unchanged) {
    logger?.info("clients reconciled", {
      created: diff.created.length,
      updated: diff.updated.length,
      disabled: diff.disabled.length,
      deleted: diff.deleted.length,
      relinked: diff.relinked.length,
    })
    // Ids only: a client secret must never reach the trail (SEC-6, SEC-10).
    await audit?.record({
      action: "client.reconciled",
      outcome: "success",
      actorType: "system",
      metadata: {
        created: diff.created,
        updated: diff.updated,
        disabled: diff.disabled,
        deleted: diff.deleted,
        relinked: diff.relinked,
      },
    })
  }

  return diff
}

type ClientTableRow = Record<string, unknown>

/** The columns reconciliation owns; anything else on the row is not ours. */
const OWNED_COLUMNS = [
  "clientSecret",
  "name",
  "disabled",
  "skipConsent",
  "enableEndSession",
  "scopes",
  "redirectUris",
  "postLogoutRedirectUris",
  "grantTypes",
  "responseTypes",
  "requirePKCE",
  "tokenEndpointAuthMethod",
  "applicationType",
  "uri",
  "icon",
  "contacts",
  "tos",
  "policy",
  "metadata",
  "userId",
] as const satisfies readonly (keyof ClientRow)[]

function differs(current: ClientTableRow, desired: ClientRow): boolean {
  return OWNED_COLUMNS.some(
    (column) => !equal(current[column], desired[column])
  )
}

function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => equal(value, b[i]))
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    // `null` and `undefined` both mean "not set" as far as a column goes.
    return (a ?? null) === (b ?? null)
  }
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return a === b
}

/**
 * A transaction handle. Exported because the admin client endpoints (D50) run
 * {@link syncResourceLinks} and {@link revokeTokensFor} in transactions of
 * their own, and a second implementation of either would be a second chance to
 * leave a deleted client's refresh tokens alive.
 */
export type Tx = Parameters<Parameters<DbHandle["db"]["transaction"]>[0]>[0]
export type Schema = DbHandle["schema"]

/**
 * Brings `oauth_client_resource` into line for one client.
 *
 * Only links to resources that actually exist are written: the provider seeds
 * `oauth_resource` from `config.resources` in its own `init()`, and a link to
 * a missing identifier would violate the foreign key and abort the whole
 * transaction over a typo in one client's `audience`.
 */
export async function syncResourceLinks(
  tx: Tx,
  schema: Schema,
  clientId: string,
  wanted: readonly string[]
): Promise<boolean> {
  const known = await tx
    .select({ identifier: schema.oauthResource.identifier })
    .from(schema.oauthResource)
  const knownIds = new Set(known.map((row) => row.identifier))
  const writable = wanted.filter((identifier) => knownIds.has(identifier))

  const current = await tx
    .select({ resourceId: schema.oauthClientResource.resourceId })
    .from(schema.oauthClientResource)
    .where(eq(schema.oauthClientResource.clientId, clientId))
  const currentIds = new Set(current.map((row) => row.resourceId))

  const toAdd = writable.filter((identifier) => !currentIds.has(identifier))
  const toRemove = [...currentIds].filter(
    (identifier) => !writable.includes(identifier)
  )

  if (toAdd.length === 0 && toRemove.length === 0) return false

  if (toRemove.length > 0) {
    await tx
      .delete(schema.oauthClientResource)
      .where(
        and(
          eq(schema.oauthClientResource.clientId, clientId),
          inArray(schema.oauthClientResource.resourceId, toRemove)
        )
      )
  }
  if (toAdd.length > 0) {
    await tx.insert(schema.oauthClientResource).values(
      toAdd.map((resourceId) => ({
        id: crypto.randomUUID(),
        clientId,
        resourceId,
        createdAt: new Date(),
      }))
    )
  }
  return true
}

/**
 * Kills everything a removed client could still be holding (FR-OIDC-2).
 *
 * Consents go too: a client that comes back later is a *new* grant decision,
 * and silently resuming the old one would let a removed-and-restored client
 * skip the consent screen it should have seen.
 */
export async function revokeTokensFor(
  tx: Tx,
  schema: Schema,
  clientId: string
): Promise<void> {
  const now = new Date()
  await tx
    .update(schema.oauthRefreshToken)
    .set({ revoked: now })
    .where(eq(schema.oauthRefreshToken.clientId, clientId))
  await tx
    .delete(schema.oauthAccessToken)
    .where(eq(schema.oauthAccessToken.clientId, clientId))
  await tx
    .delete(schema.oauthConsent)
    .where(eq(schema.oauthConsent.clientId, clientId))
}
