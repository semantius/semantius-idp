/**
 * The process-wide runtime: configuration, database and auth instance,
 * constructed once (CFG-5 "configuration is read once", OPS-2).
 *
 * Server routes and server functions reach the IdP through `await getRuntime()`.
 * There is no hot reload and no per-request construction: a second connection
 * pool or a second Better Auth instance would mean two sets of rate-limit
 * counters, two key caches and two views of the config.
 *
 * **Why it is async.** The OAuth provider plugin seeds `oauth_resource` from
 * its own `init()`, which runs the moment the Better Auth instance is built —
 * so on a fresh database the instance cannot be constructed until migrations
 * have run. Building the runtime therefore *is* the OPS-2 sequence, in order,
 * and every caller naturally waits for it rather than racing it.
 *
 * The promise is memoized, so concurrent callers share one startup and one
 * pool. A failed startup is not cached: the next request retries, which is what
 * an operator fixing a config typo expects.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import { createAuth } from "./auth/instance"
import type { Auth } from "./auth/instance"
import { createAudit } from "./audit"
import { createMailer } from "./email/mailer"
import type { Mailer } from "./email/mailer"
import type { Audit } from "./audit"
import { loadConfig } from "./config/loader"
import type { LoadedConfig } from "./config/loader"
import type { IdpConfig } from "./config/derive"
import { createAdminContext } from "./admin/context"
import { startCleanupJob } from "./cleanup"
import { createDb } from "./db/client"
import type { DbHandle } from "./db/client"
import { loadDevEnv } from "./dev-env"
import { createLogger } from "./logger"
import type { Logger } from "./logger"
import { runMigrationPhase, runStartup } from "./startup"
import type { StartupResult } from "./startup"

export interface Runtime {
  config: IdpConfig
  database: DbHandle
  auth: Auth
  audit: Audit
  mailer: Mailer
  logger: Logger
  /** What the OPS-2 sequence did, for the log and `/admin/system`. */
  startup: StartupResult
  /** Where the configuration was read from, for `/admin/system`. */
  configDir: string
  /** Non-fatal configuration problems, logged once at startup (CFG-5). */
  warnings: LoadedConfig["warnings"]
  shutdown: () => Promise<void>
}

let pending: Promise<Runtime> | undefined

export function getRuntime(): Promise<Runtime> {
  pending ??= buildRuntime().catch((error: unknown) => {
    // Do not cache a failure: an operator who fixes the config expects the
    // next request to pick it up without restarting the container.
    pending = undefined
    throw error
  })
  return pending
}

/** Replaces the process runtime. Used by the CLI, which builds its own. */
export function setRuntime(next: Runtime): void {
  pending = Promise.resolve(next)
}

/**
 * Closes the runtime **if one was ever built** (OPS-4).
 *
 * Pointedly not `getRuntime().then(r => r.shutdown())`: that would *build* a
 * runtime in order to close it, so a process signalled before it served its
 * first request would run migrations, seed a signing key and reconcile clients
 * on its way to exiting. A start-up that failed is also nothing to close —
 * awaiting the rejected promise here would turn a shutdown into a crash, so it
 * is swallowed.
 */
export async function shutdownRuntime(): Promise<void> {
  const current = pending
  if (!current) return
  pending = undefined
  const runtime = await current.catch(() => undefined)
  await runtime?.shutdown().catch(() => undefined)
}

export async function buildRuntime(): Promise<Runtime> {
  loadDevEnv()
  const { config, warnings, dir } = loadConfig()

  const logger = createLogger({
    level: config.file.logging.level,
    format: config.file.logging.format,
    base: { service: "idp" },
  })

  for (const warning of warnings) {
    logger.warn(warning.message, { warningCode: warning.code })
  }

  // Request traffic uses the configured (possibly pooled) URL; every
  // advisory-locked step uses the direct one, because a session lock does not
  // hold through a transaction pooler (S4).
  const database = createDb(config)
  const locking = createDb(config, { direct: true, max: 2 })

  // FR-ADMIN-7. `/admin/database` never touches `database`: one legal
  // statement inside a READ ONLY transaction -- `select set_config('search_path',
  // …, false)` is the easy example -- changes session state that a pooled
  // connection then hands to the next piece of ordinary traffic. Its own
  // handles contain that to the console. `max: 1` serializes concurrent
  // queries, which is right for a single-admin console and safe here because
  // no advisory lock is involved (the AGENTS.md `max: 1` deadlock warning is
  // about `withAdvisoryLock`, which reserves a connection for the whole
  // critical section).
  //
  // `read` goes over the pooled URL, `read-write` over the direct one. D74's
  // mutual fallback means a single-endpoint deployment resolves both names to
  // the same string, so "when configured" needs no extra branch.
  const consoleEnabled = config.file.admin.database !== "disabled"
  const consoleDb = consoleEnabled ? createDb(config, { max: 1 }) : undefined
  const consoleDirectDb =
    config.file.admin.database === "read-write"
      ? createDb(config, { direct: true, max: 1 })
      : undefined

  try {
    const migrateStep = await runMigrationPhase({
      config,
      database,
      locking,
      logger,
    })

    // Safe to construct now: the tables the plugins touch on init exist.
    const mailer = createMailer({ config, logger })
    const audit = createAudit(database, logger)
    // Handed to the instance empty and filled in as each piece appears; see
    // `admin/context.ts` for why this is not a module-level singleton.
    const adminContext = createAdminContext()
    const auth = createAuth({
      config,
      database,
      logger,
      mailer,
      audit,
      adminContext,
      consoleDb,
      consoleDirectDb,
    })
    adminContext.auth = auth
    // D55: the discovery list on the system page names `security.txt` only
    // when there is one, because the route 404s otherwise. Read here, where
    // the config folder is already in hand.
    adminContext.securityTxt = existsSync(join(dir, "security.txt"))

    const startup = await runStartup(
      { config, database, locking, auth, logger },
      [migrateStep]
    )
    adminContext.startup = startup

    // **After start-up, never as part of it** (OPS-8). A sweep is not a
    // readiness condition: making the first one block `/readyz` would delay
    // every deploy by however long the largest table takes, for work that has
    // no deadline. It gets its own direct handle because the lock is
    // session-scoped and must not share a connection with a startup step that
    // may still be finishing.
    const cleanupLocking = createDb(config, { direct: true, max: 1 })
    const cleanup = startCleanupJob({
      config,
      database,
      locking: cleanupLocking,
      logger,
    })

    return {
      config,
      database,
      auth,
      audit,
      mailer,
      logger,
      startup,
      configDir: dir,
      warnings,
      shutdown: async () => {
        // Stop scheduling before closing anything a sweep would use.
        cleanup.stop()
        await cleanupLocking.close().catch(() => undefined)
        await consoleDb?.close().catch(() => undefined)
        await consoleDirectDb?.close().catch(() => undefined)
        await database.close()
        pending = undefined
      },
    }
  } catch (error) {
    await database.close().catch(() => undefined)
    await consoleDb?.close().catch(() => undefined)
    await consoleDirectDb?.close().catch(() => undefined)
    throw error
  } finally {
    await locking.close().catch(() => undefined)
  }
}
