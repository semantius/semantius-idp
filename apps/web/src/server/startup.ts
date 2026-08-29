/**
 * Startup sequence (OPS-2).
 *
 * ```
 * load + validate config → connect DB → migrate → ensure signing key
 *   → reconcile clients/resources → refresh client origins
 *   → validate roles against the DB → first-run check → listen → ready
 * ```
 *
 * Two rules hold throughout:
 *
 * - **Every shared-state step runs under a Postgres advisory lock** on the
 *   *direct* connection (`database.directUrl`), because a session lock does not
 *   hold through a transaction pooler — see `docs/spikes/s4-schema-placement.md`.
 *   Single-instance is the supported topology (OPS-11), but two containers
 *   restarting together is ordinary, and neither may half-apply anything.
 *
 * - **Any failure exits non-zero with one actionable error.** Not a stack
 *   trace, not three cascading errors: the operator gets the sentence that says
 *   what to change.
 */

import { eq } from "drizzle-orm"

import { isSetupPending } from "./admin/first-user"
import { createAudit } from "./audit"
import type { IdpConfig } from "./config/derive"
import { ConfigError } from "./config/errors"
import type { DbHandle } from "./db/client"
import { withAdvisoryLock } from "./db/advisory-lock"
import { migrationsAreCurrent, runMigrations } from "./db/migrate"
import type { Logger } from "./logger"
import type { Auth } from "./auth/instance"
import { splitRoles } from "./role-utils"
import { refreshDatabaseClientOrigins } from "./oidc/client-origins"
import { reconcileClients } from "./oidc/reconcile"
import type { ReconcileDiff } from "./oidc/reconcile"
import { reconcileGateways } from "./gateways/reconcile"
import type { GatewayReconcileDiff } from "./gateways/reconcile"

export interface StartupDeps {
  config: IdpConfig
  /** The request-serving handle (pooled). */
  database: DbHandle
  /** Direct, non-pooled handle used for every advisory-locked step. */
  locking: DbHandle
  auth: Auth
  logger: Logger
}

export interface StartupResult {
  /** Steps that ran, in order, for the log and the admin system page. */
  steps: { name: string; skipped?: string }[]
  /** What the FR-OIDC-2 sync did, for `/admin/system` (M10). */
  reconcile?: ReconcileDiff
  /** What the FR-GW-2 sync did, for `/admin/system` (**D91**). */
  gateways?: GatewayReconcileDiff
  /**
   * Roles stored on users that the catalog does not contain (FR-ROLE-2).
   *
   * Rendered on `/admin/roles`, which is the page that can do something about
   * them, and which FR-ADMIN-2 asks for "warnings" on. Deliberately *not*
   * `runtime.warnings`: those are configuration-load problems and are already
   * on `/admin` and `/admin/system`, so putting them here too would show the
   * same red box three times while the one warning that is actually about
   * roles went nowhere but the log.
   */
  roleWarnings: string[]
  /**
   * When the sequence finished, ISO-8601 UTC.
   *
   * FR-ADMIN-2 asks the roles page for a "last reconcile" timestamp, and
   * reconciliation happens exactly once, here — the process has been up since
   * this instant, so this *is* the answer. There is no per-step time because
   * there is no case where one step's time and another's differ usefully.
   */
  completedAt: string
}

export type StartupStep = StartupResult["steps"][number]

/**
 * The part of the sequence that must happen **before the Better Auth instance
 * is constructed**.
 *
 * The OAuth provider plugin seeds `oauth_resource` from its own `init()`, which
 * runs as soon as the instance is built. On a fresh database that is a query
 * against a table that does not exist yet, and the process dies before it can
 * migrate. So migrations come first, on the direct connection, under the lock —
 * which is the order OPS-2 states anyway.
 */
export async function runMigrationPhase(deps: {
  config: IdpConfig
  database: DbHandle
  locking: DbHandle
  logger: Logger
}): Promise<StartupStep> {
  if (deps.config.file.database.migrateOnBoot) {
    await runMigrations(deps.locking, { logger: deps.logger })
    return { name: "migrate" }
  }

  if (!(await migrationsAreCurrent(deps.database))) {
    throw new StartupError(
      "The database is not migrated and `database.migrateOnBoot` is false. " +
        "Run `idp migrate` against this database, or set `database.migrateOnBoot: true`."
    )
  }
  return { name: "migrate", skipped: "database.migrateOnBoot is false" }
}

/** Thrown with the single actionable message an operator should act on. */
export class StartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "StartupError"
  }
}

/**
 * The rest of the sequence, run once the auth instance exists:
 * signing key → reconcile clients/resources → client origins → validate roles
 * → first-run check.
 */
export async function runStartup(
  deps: StartupDeps,
  earlier: StartupStep[] = []
): Promise<StartupResult> {
  const { config, logger, locking } = deps
  const steps: StartupResult["steps"] = [...earlier]
  const audit = createAudit(deps.database, logger)
  let lastReconcile: ReconcileDiff | undefined
  let lastGatewayReconcile: GatewayReconcileDiff | undefined

  // -- signing key (FR-OIDC-16, risk R11) ----------------------------------
  await step(steps, "signing key", async () => {
    await ensureSigningKey(deps, locking)
  })

  // -- clients and resources (FR-OIDC-2) -----------------------------------
  // After the auth instance exists, because the OAuth provider seeds
  // `oauth_resource` in its own `init()` and the per-client links point at
  // those rows.
  if (config.clients.length === 0) {
    steps.push({ name: "reconcile clients", skipped: "no clients configured" })
  } else {
    await step(steps, "reconcile clients", async () => {
      lastReconcile = await reconcileClients({
        config,
        database: deps.database,
        locking,
        audit,
        logger,
      })
    })
  }

  // -- gateways (FR-GW-2, **D91**) -----------------------------------------
  // Skipped only when there is nothing to do *and* nothing to undo: an empty
  // `gateways` block with rows still in the table is exactly the case the
  // sweep exists for — a target removed from the file has to stop answering.
  if (
    Object.keys(config.file.gateways).length === 0 &&
    !(await hasConfigGateways(deps.database))
  ) {
    steps.push({ name: "reconcile gateways", skipped: "no gateways configured" })
  } else {
    await step(steps, "reconcile gateways", async () => {
      lastGatewayReconcile = await reconcileGateways({
        config,
        database: deps.database,
        locking,
        audit,
        logger,
      })
    })
  }

  // -- client origins (D50, FR-OIDC-17, SEC-4) -----------------------------
  // After the reconcile, because it reads the rows the reconcile just wrote.
  // Admin-registered clients are not in the configuration file, so without
  // this their origins are missing from CORS and from the CSP `form-action`
  // list until somebody restarts — and the failure is a blocked redirect in
  // Chrome with nothing in the log that names an origin.
  await step(steps, "client origins", async () => {
    await refreshDatabaseClientOrigins(deps.database, logger)
  })

  // -- roles vs. the database (FR-ROLE-2) ----------------------------------
  let roleWarnings: string[] = []
  await step(steps, "validate roles", async () => {
    roleWarnings = await warnAboutUnknownRoles(deps)
  })

  // -- first-run check (FR-ADMIN-1, D52) -----------------------------------
  // Nothing is created here. The IdP no longer provisions an administrator
  // from configuration — an empty `user` table opens `/setup` instead — so
  // start-up's job is to say so, once, in the place an operator is already
  // looking.
  await step(steps, "first-run check", async () => {
    await announceSetupIfPending(deps)
  })

  logger.info("startup complete", {
    steps: steps.map((entry) =>
      entry.skipped ? `${entry.name} (skipped)` : entry.name
    ),
    issuer: config.base.origin + config.base.basePath,
  })
  return {
    steps,
    roleWarnings,
    completedAt: new Date().toISOString(),
    ...(lastReconcile ? { reconcile: lastReconcile } : {}),
    ...(lastGatewayReconcile ? { gateways: lastGatewayReconcile } : {}),
  }
}

async function step(
  steps: StartupResult["steps"],
  name: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run()
    steps.push({ name })
  } catch (error) {
    if (error instanceof StartupError || error instanceof ConfigError)
      throw error
    throw new StartupError(
      `Startup failed during "${name}": ${describe(error)}`,
      { cause: error }
    )
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Ensures a signing key exists before anything can need one (FR-OIDC-16).
 *
 * Generating it lazily on the first token request would mean two concurrent
 * requests could each generate one, and the first client to fetch the JWKS
 * might see a key that is not yet the signing key (risk R11). Creating it here,
 * under a lock, means a key is always *published before it signs*.
 */
async function ensureSigningKey(
  deps: StartupDeps,
  locking: DbHandle
): Promise<void> {
  await withAdvisoryLock(locking.sql, "signingKey", async () => {
    const existing = await locking.db
      .select({ id: locking.schema.jwks.id })
      .from(locking.schema.jwks)
      .limit(1)
    if (existing.length > 0) return

    // The JWKS endpoint is the supported way to materialise the first key pair:
    // it generates it, encrypts the private half with `secret`, stores it and
    // publishes it — all before anything can ask for a signature.
    const response = await deps.auth.handler(
      new Request(
        `${deps.config.base.origin}${deps.config.base.basePath}/api/auth/jwks`
      )
    )
    if (!response.ok) {
      throw new StartupError(
        `Could not generate the signing key (JWKS endpoint returned ${response.status}). ` +
          "Check that `secret` is set and the database is writable."
      )
    }

    deps.logger.info("signing key generated", {
      algorithm: deps.config.file.jwt.algorithm,
    })
  })
}

/**
 * FR-ROLE-2: a role that is stored on a user but no longer in `roles.jsonc` is
 * dropped from their claims. That is a silent behaviour change for whoever
 * holds it, so it is warned about at boot and flagged in the admin UI.
 */
/** Returns what it logged, so `/admin/roles` can show the same thing. */
/**
 * Whether the table still holds a file-owned gateway (FR-GW-2).
 *
 * The reason the step is not simply skipped on an empty `gateways` block: a
 * target removed from the file has to *stop answering*, and the sweep that
 * makes that true is the step that would have been skipped.
 */
async function hasConfigGateways(database: DbHandle): Promise<boolean> {
  const rows = await database.db
    .select({ id: database.schema.gateway.id })
    .from(database.schema.gateway)
    .where(eq(database.schema.gateway.source, "config"))
    .limit(1)
  return rows.length > 0
}

async function warnAboutUnknownRoles(deps: StartupDeps): Promise<string[]> {
  const catalog = new Set(deps.config.roles.map((role) => role.name))
  const rows = await deps.database.db
    .select({ role: deps.database.schema.user.role })
    .from(deps.database.schema.user)

  const unknown = new Map<string, number>()
  for (const row of rows) {
    for (const name of splitRoles(row.role)) {
      if (catalog.has(name)) continue
      unknown.set(name, (unknown.get(name) ?? 0) + 1)
    }
  }

  const messages: string[] = []
  for (const [name, count] of unknown) {
    deps.logger.warn(
      "stored role is not in the catalog and will be dropped from claims",
      {
        role: name,
        users: count,
        hint: "Add it to roles.jsonc, or reassign those users in /admin/users.",
      }
    )
    messages.push(
      `${count} user${count === 1 ? "" : "s"} hold the role "${name}", which is not in roles.jsonc. ` +
        `It is dropped from their claims. Add it to the file, or reassign them in /admin/users.`
    )
  }
  return messages
}

/**
 * Says, at boot, that nobody can sign in yet — and where to fix that (D52).
 *
 * The old sequence created an administrator here from `admin.bootstrap`. That
 * meant a password in an environment file, a forced change at the first
 * sign-in, and an instruction to unset two variables afterwards which nobody
 * follows. What replaces it is a page: while the `user` table is empty, `/` and
 * `/login` both lead to `/setup`, and whoever completes it is the first
 * administrator.
 *
 * Logged at `warn` because a deployment nobody can sign in to is worth
 * noticing in a log, and priming the memoised gate here means the first
 * request does not pay for the query.
 */
async function announceSetupIfPending(deps: StartupDeps): Promise<void> {
  if (!(await isSetupPending(deps.database))) return

  deps.logger.warn("no users yet", {
    hint: `Finish setup at ${deps.config.base.origin}${deps.config.base.basePath}/setup`,
  })
}
