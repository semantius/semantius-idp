/**
 * `idp` — the operator CLI (OPS-6).
 *
 * A skeleton, deliberately. `package.json`'s `db:migrate` script has pointed
 * at `src/cli/index.ts migrate` since M1 and the file did not exist, so the
 * script failed with a module-not-found error rather than migrating anything.
 * This makes the one command that was already promised work, and fixes the
 * shape M12 fills in: argv dispatch, one function per command, a single exit
 * path, and a usage line that lists what is real rather than what is planned.
 *
 * The remaining OPS-6 commands — `config validate`, `create-admin`,
 * `rotate-keys`, `cleanup` — arrive with the milestones that give them
 * something to do. A command that exists but does nothing is worse than one
 * that is honestly absent, so they are not stubbed here.
 *
 * **Every mutating command runs on the direct connection under its own
 * advisory lock** (D27). A session lock does not hold through a transaction
 * pooler, so two containers starting together would each believe they held
 * the migration lock and both apply the same SQL.
 *
 *   bun run src/cli/index.ts migrate
 *   bun run src/cli/index.ts version
 */

import { createLogOnlyAudit } from "../server/audit"
import { loadConfig } from "../server/config/loader"
import { createDb } from "../server/db/client"
import { runMigrations } from "../server/db/migrate"
import { loadDevEnv } from "../server/dev-env"
import { createLogger } from "../server/logger"
import { reconcileClients } from "../server/oidc/reconcile"
import { revision, version } from "../server/version"

const USAGE = `idp ${version}

Usage:
  idp migrate             Apply pending database migrations (DM-1, OPS-6)
  idp reconcile-clients   Sync oauth_clients.json into the database (FR-OIDC-2)
  idp version             Print the running version

Configuration is read from IDP_CONFIG_DIR, or /config (CFG-1).`

async function migrate(): Promise<void> {
  loadDevEnv()
  const { config, warnings } = loadConfig()
  const logger = createLogger({
    level: config.file.logging.level,
    format: config.file.logging.format,
    base: { service: "idp-cli" },
  })
  for (const warning of warnings) {
    logger.warn(warning.message, { warningCode: warning.code })
  }

  // Direct, never the pooled URL: this takes a session advisory lock (D27).
  //
  // `runMigrations` takes `LOCK_KEYS.migrate` itself. Wrapping it in another
  // `withAdvisoryLock` deadlocks the process against its own lock — the outer
  // call pins one pooled connection and the inner one reserves a second,
  // which is a different session as far as Postgres is concerned, so it waits
  // out the full timeout and fails. Which is exactly what it did here.
  const database = createDb(config, { direct: true, max: 2 })
  try {
    await runMigrations(database, { logger })
  } finally {
    await database.close()
  }
}

/**
 * `idp reconcile-clients` — the same sync startup runs, on demand (OPS-6).
 *
 * Useful when `oauth_clients.json` changed and restarting the container is
 * more disruptive than running one command. It takes the same advisory lock
 * as startup, so running it *while* a container boots is safe: one waits.
 *
 * The audit trail is written to the log only. Wiring the database audit here
 * would need the whole Better Auth instance for nothing this command uses.
 *
 * One consequence of not building that instance: the OAuth provider seeds
 * `oauth_resource` from its own `init()`, so on a database that has never
 * booted there are no resources yet and the per-client links (FR-OIDC-6) come
 * out empty. The next start-up reconcile creates them. Running this against a
 * database an IdP has already started against — the case it exists for — is
 * unaffected.
 */
async function reconcile(): Promise<void> {
  loadDevEnv()
  const { config, warnings } = loadConfig()
  const logger = createLogger({
    level: config.file.logging.level,
    format: config.file.logging.format,
    base: { service: "idp-cli" },
  })
  for (const warning of warnings) {
    logger.warn(warning.message, { warningCode: warning.code })
  }

  if (config.clients.length === 0) {
    logger.warn(
      "no clients configured; every client row in the database will be disabled"
    )
  }

  const database = createDb(config, { max: 2 })
  const locking = createDb(config, { direct: true, max: 2 })
  try {
    const diff = await reconcileClients({
      config,
      database,
      locking,
      audit: createLogOnlyAudit(logger),
      logger,
    })
    process.stdout.write(
      diff.unchanged
        ? "No changes: the database already matches oauth_clients.json.\n"
        : `Created ${diff.created.length}, updated ${diff.updated.length}, ` +
            `disabled ${diff.disabled.length}, deleted ${diff.deleted.length}, ` +
            `relinked ${diff.relinked.length}.\n`
    )
  } finally {
    await locking.close().catch(() => undefined)
    await database.close().catch(() => undefined)
  }
}

function printVersion(): void {
  process.stdout.write(revision ? `${version} (${revision})\n` : `${version}\n`)
}

export async function run(argv: readonly string[]): Promise<number> {
  const [command] = argv

  switch (command) {
    case "migrate":
      await migrate()
      return 0
    case "reconcile-clients":
      await reconcile()
      return 0
    case "version":
    case "--version":
    case "-v":
      printVersion()
      return 0
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${USAGE}\n`)
      return command === undefined ? 1 : 0
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`)
      return 1
  }
}

// `import.meta.main` is true only when this file is the entry point, so the
// integration tests can import `run` without the process exiting under them.
if (import.meta.main) {
  try {
    process.exit(await run(process.argv.slice(2)))
  } catch (error) {
    // One actionable line, not a stack: an operator running `idp migrate` in a
    // container wants to know what to fix (the same contract as StartupError).
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(1)
  }
}
