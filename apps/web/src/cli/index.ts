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
 * The remaining OPS-6 commands — `config validate`, `reconcile-clients`,
 * `create-admin`, `rotate-keys`, `cleanup` — arrive with the milestones that
 * give them something to do. A command that exists but does nothing is worse
 * than one that is honestly absent, so they are not stubbed here.
 *
 * **Every mutating command runs on the direct connection under its own
 * advisory lock** (D27). A session lock does not hold through a transaction
 * pooler, so two containers starting together would each believe they held
 * the migration lock and both apply the same SQL.
 *
 *   bun run src/cli/index.ts migrate
 *   bun run src/cli/index.ts version
 */

import { loadConfig } from "../server/config/loader"
import { createDb } from "../server/db/client"
import { runMigrations } from "../server/db/migrate"
import { loadDevEnv } from "../server/dev-env"
import { createLogger } from "../server/logger"
import { revision, version } from "../server/version"

const USAGE = `idp ${version}

Usage:
  idp migrate     Apply pending database migrations (DM-1, OPS-6)
  idp version     Print the running version

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

function printVersion(): void {
  process.stdout.write(
    revision ? `${version} (${revision})\n` : `${version}\n`
  )
}

export async function run(argv: readonly string[]): Promise<number> {
  const [command] = argv

  switch (command) {
    case "migrate":
      await migrate()
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
