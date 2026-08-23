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
 * The promise is memoised, so concurrent callers share one startup and one
 * pool. A failed startup is not cached: the next request retries, which is what
 * an operator fixing a config typo expects.
 */

import { createAuth } from "./auth/instance"
import type { Auth } from "./auth/instance"
import { createAudit } from "./audit"
import { createMailer } from "./email/mailer"
import type { Mailer } from "./email/mailer"
import type { Audit } from "./audit"
import { loadConfig } from "./config/loader"
import type { LoadedConfig } from "./config/loader"
import type { IdpConfig } from "./config/derive"
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

  try {
    const migrateStep = await runMigrationPhase({
      config,
      database,
      locking,
      logger,
    })

    // Safe to construct now: the tables the plugins touch on init exist.
    const mailer = createMailer({ config, logger })
    const auth = createAuth({ config, database, logger, mailer })
    const audit = createAudit(database, logger)

    const startup = await runStartup(
      { config, database, locking, auth, logger },
      [migrateStep]
    )

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
        await database.close()
        pending = undefined
      },
    }
  } catch (error) {
    await database.close().catch(() => undefined)
    throw error
  } finally {
    await locking.close().catch(() => undefined)
  }
}
