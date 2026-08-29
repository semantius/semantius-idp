/**
 * `config.jsonc`'s `gateways` block is the source of truth; this makes the
 * database agree (FR-GW-2, **D91**).
 *
 * A near-copy of `oidc/reconcile.ts`, on purpose and for the same reasons: the
 * file is edited, the container restarts, and the rows follow — which only
 * works if the sync is total. A gateway removed from the file has to *stop
 * answering*, not linger because nobody deleted it, so absence is a decision:
 * the row is disabled, or deleted outright when `oauth.reconcile.prune` says
 * so. That key governs both sweeps rather than growing a twin, because an
 * operator who wants file removals pruned wants it for the file, not per
 * feature.
 *
 * **The sweep is scoped to `source = 'config'`.** That column is the one
 * deliberate divergence from the clients, where the marker is `userId === null`
 * (D50): here the row says what it is, and the orphan query is a plain
 * `source === "config"` test rather than a null check whose meaning has to be
 * remembered.
 *
 * **A config row is file-owned end to end**, which includes `enabled`. Leaving
 * an operator's toggle in place across a restart was the alternative and it is
 * worse: the file would then say one thing and the deployment do another, with
 * nothing on the page explaining which won. A config gateway is switched off
 * by removing it from the file.
 *
 * Everything in one transaction under one advisory lock on the direct
 * connection, for the reasons `oidc/reconcile.ts` sets out at length (D27, S4).
 */

import { and, eq, inArray, ne } from "drizzle-orm"

import type { Audit } from "../audit"
import type { IdpConfig } from "../config/derive"
import { LOCK_KEYS, withAdvisoryLock } from "../db/advisory-lock"
import type { DbHandle } from "../db/client"
import type { Logger } from "../logger"
import { resetGatewayRegistry } from "./registry"

export interface GatewayReconcileDeps {
  config: IdpConfig
  /** Request traffic's handle: the transaction itself. */
  database: DbHandle
  /** The **direct** connection, for the advisory lock (D27). */
  locking: DbHandle
  audit?: Audit
  logger?: Logger
}

/** What changed, for the log, the audit row and `/admin/system`. */
export interface GatewayReconcileDiff {
  created: string[]
  updated: string[]
  /** Present in the database, absent from the file: disabled, or pruned. */
  disabled: string[]
  deleted: string[]
  /** True when nothing at all had to be written. */
  unchanged: boolean
}

const EMPTY_DIFF: GatewayReconcileDiff = {
  created: [],
  updated: [],
  disabled: [],
  deleted: [],
  unchanged: true,
}

/** Exported for the test that runs two reconciles concurrently. */
export const GATEWAY_RECONCILE_LOCK = LOCK_KEYS.reconcileGateways

export async function reconcileGateways(
  deps: GatewayReconcileDeps
): Promise<GatewayReconcileDiff> {
  return withAdvisoryLock(
    deps.locking.sql,
    "reconcileGateways",
    async () => applyReconciliation(deps),
    { timeoutSeconds: 60 }
  ).then((result) => result ?? EMPTY_DIFF)
}

/** The columns reconciliation owns; anything else on the row is not ours. */
const OWNED_COLUMNS = ["url", "requireAuth", "enabled"] as const

async function applyReconciliation(
  deps: GatewayReconcileDeps
): Promise<GatewayReconcileDiff> {
  const { config, database, audit, logger } = deps
  const schema = database.schema
  const entries = Object.entries(config.file.gateways)
  const wantedNames = entries.map(([name]) => name)

  const diff: GatewayReconcileDiff = {
    created: [],
    updated: [],
    disabled: [],
    deleted: [],
    unchanged: true,
  }

  await database.db.transaction(async (tx) => {
    const existing = await tx.select().from(schema.gateway)
    const byName = new Map(existing.map((row) => [row.name, row]))

    for (const [name, target] of entries) {
      const current = byName.get(name)
      const desired = {
        url: target.url,
        requireAuth: target.requireAuth,
        // File-owned: a restart re-enables a config gateway an administrator
        // switched off, which is the point (see the header).
        enabled: true,
      }

      if (!current) {
        await tx.insert(schema.gateway).values({
          id: crypto.randomUUID(),
          name,
          ...desired,
          source: "config",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        diff.created.push(name)
        continue
      }

      // A name that exists as a `manual` row and then appears in the file is
      // the one collision this can hit — `name` is unique. The file wins and
      // the row becomes file-owned, because the alternative is a config entry
      // that silently does nothing and no page saying why.
      const claiming = current.source !== "config"
      if (claiming || differs(current, desired)) {
        await tx
          .update(schema.gateway)
          // `createdAt` is deliberately absent: it records when the gateway
          // first appeared, not when it was last edited.
          .set({ ...desired, source: "config", updatedAt: new Date() })
          .where(eq(schema.gateway.name, name))
        diff.updated.push(name)
      }
    }

    // -- absent from the file (FR-GW-2) -----------------------------------
    const orphans = existing.filter(
      (row) => row.source === "config" && !wantedNames.includes(row.name)
    )
    if (orphans.length > 0) {
      const names = orphans.map((row) => row.name)
      if (config.file.oauth.reconcile.prune) {
        await tx
          .delete(schema.gateway)
          .where(
            and(
              inArray(schema.gateway.name, names),
              ne(schema.gateway.source, "manual")
            )
          )
        diff.deleted.push(...names)
      } else {
        // Already-disabled orphans are not a change and must not be reported
        // as one, or an unchanged file writes an audit row on every boot.
        const live = orphans
          .filter((row) => row.enabled !== false)
          .map((row) => row.name)
        if (live.length > 0) {
          await tx
            .update(schema.gateway)
            .set({ enabled: false, updatedAt: new Date() })
            .where(
              and(
                inArray(schema.gateway.name, live),
                ne(schema.gateway.source, "manual")
              )
            )
          diff.disabled.push(...live)
        }
      }
    }
  })

  diff.unchanged =
    diff.created.length === 0 &&
    diff.updated.length === 0 &&
    diff.disabled.length === 0 &&
    diff.deleted.length === 0

  if (!diff.unchanged) {
    // The proxy reads a module-level map; a reconcile that did not clear it
    // would serve the previous boot's targets until the TTL expired.
    resetGatewayRegistry()
    logger?.info("gateways reconciled", {
      created: diff.created.length,
      updated: diff.updated.length,
      disabled: diff.disabled.length,
      deleted: diff.deleted.length,
    })
    // Names only. A target URL can carry a host an operator would rather not
    // publish, and the trail is a page an administrator reads (SEC-6).
    await audit?.record({
      action: "gateway.reconciled",
      outcome: "success",
      actorType: "system",
      metadata: {
        created: diff.created,
        updated: diff.updated,
        disabled: diff.disabled,
        deleted: diff.deleted,
      },
    })
  }

  return diff
}

function differs(
  current: {
    url: string
    requireAuth: boolean | null
    enabled: boolean | null
  },
  desired: { url: string; requireAuth: boolean; enabled: boolean }
): boolean {
  return OWNED_COLUMNS.some((column) => {
    if (column === "url") return current.url !== desired.url
    if (column === "requireAuth")
      return (current.requireAuth === true) !== desired.requireAuth
    return (current.enabled !== false) !== desired.enabled
  })
}
