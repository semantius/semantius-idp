/**
 * Startup sequence.
 *
 * ```
 * load + validate config → connect DB → migrate → ensure signing key
 *   → reconcile clients/resources → refresh client origins
 *   → validate roles against the DB → first-run check
 *   → database role check → listen → ready
 * ```
 *
 * Two rules hold throughout:
 *
 * - **Every shared-state step runs under a Postgres advisory lock** on the
 *   *direct* connection (`database.directUrl`), because a session lock does not
 *   hold through a transaction pooler — two connections through a pooled
 *   endpoint can both believe they hold it.
 *   Single-instance is the supported topology, but two containers
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
import type { ConfigWarning } from "./config/errors"
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
  /** What the profile sync did, for `/admin/system`. */
  reconcile?: ReconcileDiff
  /** What the profile sync did, for `/admin/system`. */
  gateways?: GatewayReconcileDiff
  /**
   * Roles stored on users that the catalog does not contain.
   *
   * Rendered on `/admin/roles`, which is the page that can do something about
   * them, and which the spec asks for "warnings" on. Deliberately *not*
   * `runtime.warnings`: those are configuration-load problems and are already
   * on `/admin` and `/admin/system`, so putting them here too would show the
   * same red box three times while the one warning that is actually about
   * roles went nowhere but the log.
   */
  roleWarnings: string[]
  /**
   * Non-fatal problems only a live connection can find.
   *
   * The loader's `ConfigWarning` shape on purpose: `runtime.ts` appends these
   * to `runtime.warnings`, so they reach the log, `/admin` and `/admin/system`
   * through the one path configuration warnings already have, rather than a
   * fourth list to render. Today there is one — the database console on a
   * superuser connection — and it belongs here and not in `cross-checks.ts`
   * because the answer is in `pg_roles`, not in the file.
   */
  warnings: ConfigWarning[]
  /**
   * When the sequence finished, ISO-8601 UTC.
   *
   * the spec asks the roles page for a "last reconcile" timestamp, and
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
 * which is the order the spec states anyway.
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

  // -- signing key ----------------------------------
  await step(steps, "signing key", async () => {
    await ensureSigningKey(deps, locking)
  })

  // -- clients and resources -----------------------------------
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

  // -- gateways -----------------------------------------
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

  // -- client origins -----------------------------
  // After the reconcile, because it reads the rows the reconcile just wrote.
  // Admin-registered clients are not in the configuration file, so without
  // this their origins are missing from CORS and from the CSP `form-action`
  // list until somebody restarts — and the failure is a blocked redirect in
  // Chrome with nothing in the log that names an origin.
  await step(steps, "client origins", async () => {
    await refreshDatabaseClientOrigins(deps.database, logger)
  })

  // -- roles vs. the database ----------------------------------
  let roleWarnings: string[] = []
  await step(steps, "validate roles", async () => {
    roleWarnings = await warnAboutUnknownRoles(deps)
  })

  // -- first-run check -----------------------------------
  // Nothing is created here. The IdP no longer provisions an administrator
  // from configuration — an empty `user` table opens `/setup` instead — so
  // start-up's job is to say so, once, in the place an operator is already
  // looking.
  await step(steps, "first-run check", async () => {
    await announceSetupIfPending(deps)
  })

  // -- database role ----------------------------------
  // Only when the console exists: with it off the connection's privileges
  // are the IdP's own business, and a superuser is a common and harmless
  // choice for a database nobody types SQL into.
  const warnings: ConfigWarning[] = []
  if (config.file.admin.database === "disabled") {
    steps.push({ name: "database role", skipped: "admin.database is disabled" })
  } else {
    await step(steps, "database role", async () => {
      warnings.push(...(await warnAboutSuperuserConsole(deps)))
    })
  }

  logger.info("startup complete", {
    steps: steps.map((entry) =>
      entry.skipped ? `${entry.name} (skipped)` : entry.name
    ),
    // The canonical issuer — start-up runs outside any request, so under
    // `server.dynamicIssuer` this is the one issuer that exists yet.
    issuer: config.base.origin + config.base.basePath,
  })
  return {
    steps,
    roleWarnings,
    warnings,
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
 * Ensures a signing key exists before anything can need one.
 *
 * Generating it lazily on the first token request would mean two concurrent
 * requests could each generate one, and the first client to fetch the JWKS
 * might see a key that is not yet the signing key. Creating it here,
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

    // The JWKS endpoint is the supported way to materialize the first key pair:
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
 * a role that is stored on a user but no longer in `roles.jsonc` is
 * dropped from their claims. That is a silent behavior change for whoever
 * holds it, so it is warned about at boot and flagged in the admin UI.
 */
/** Returns what it logged, so `/admin/roles` can show the same thing. */
/**
 * Whether the table still holds a file-owned gateway.
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
 * Says, at boot, that the SQL console is running as a Postgres superuser
 * — which the console's READ ONLY transaction does
 * nothing about.
 *
 * The transaction refuses writes to tables. It does not take a privilege
 * away from the role, and a superuser inside a READ ONLY transaction still
 * runs `pg_read_file('/etc/passwd')` and `COPY (select 1) TO PROGRAM 'id'`:
 * confirmed on 2026-09-02 against the reference compose file's own bootstrap
 * user, which every quick-start deployment until then connected as. So the
 * role is the boundary, and this is the process telling the operator which
 * side of it they are on.
 *
 * A warning and not a refusal, deliberately: an existing deployment has to
 * keep booting through the upgrade that adds this check, and the fix — a
 * NOSUPERUSER role — is a provisioning change nobody can make from inside a
 * container that will not start. `read` runs over `database.url` and
 * `read-write` over `database.directUrl`, and the request handle
 * and the locking handle are built on exactly those two, so asking them is
 * asking the console's own connections without opening more.
 */
async function warnAboutSuperuserConsole(
  deps: StartupDeps
): Promise<ConfigWarning[]> {
  const mode = deps.config.file.admin.database
  const handles =
    mode === "read-write" ? [deps.database, deps.locking] : [deps.database]

  const warnings: ConfigWarning[] = []
  const seen = new Set<string>()
  for (const handle of handles) {
    const [row] = await handle.sql<{ role: string; superuser: boolean }[]>`
      select current_user::text as role, rolsuper as superuser
      from pg_roles where rolname = current_user`
    if (!row?.superuser || seen.has(row.role)) continue
    seen.add(row.role)

    const hint =
      "Connect the IdP as a NOSUPERUSER application role that is not a member of " +
      "pg_read_server_files, pg_write_server_files or pg_execute_server_program, " +
      "or set `admin.database` to `disabled`."
    deps.logger.warn("the database console runs as a Postgres superuser", {
      role: row.role,
      mode,
      hint,
    })
    warnings.push({
      code: "database.console_as_superuser",
      message:
        `\`admin.database\` is \`${mode}\` and the IdP connects as "${row.role}", a Postgres superuser. ` +
        "The console's READ ONLY transaction refuses writes to tables; it does not stop a superuser " +
        "from reading files or running programs on the database host (`pg_read_file`, " +
        "`COPY … TO PROGRAM`). " +
        hint,
    })
  }
  return warnings
}

/**
 * Says, at boot, that nobody can sign in yet — and where to fix that.
 *
 * The old sequence created an administrator here from `admin.bootstrap`. That
 * meant a password in an environment file, a forced change at the first
 * sign-in, and an instruction to unset two variables afterwards which nobody
 * follows. What replaces it is a page: while the `user` table is empty, `/` and
 * `/login` both lead to `/setup`, and whoever completes it is the first
 * administrator.
 *
 * Logged at `warn` because a deployment nobody can sign in to is worth
 * noticing in a log, and priming the memoized gate here means the first
 * request does not pay for the query.
 */
async function announceSetupIfPending(deps: StartupDeps): Promise<void> {
  if (!(await isSetupPending(deps.database))) return

  deps.logger.warn("no users yet", {
    hint: `Finish setup at ${deps.config.base.origin}${deps.config.base.basePath}/setup`,
  })
}
