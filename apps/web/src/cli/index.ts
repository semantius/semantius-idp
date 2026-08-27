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
 * All six OPS-6 commands are here. Each is a thin wrapper: the rules live in
 * the module that owns them (`server/oidc/rotate-keys.ts`,
 * `server/cleanup.ts`), so `docker run <image> idp <cmd>` and the running
 * process do the same thing rather than two similar things.
 *
 * `reset-admin` was the seventh and is gone with the env bootstrap it
 * recovered from (**D52**). Lockout recovery is now another administrator, the
 * password-reset e-mail, or the one SQL statement in `docs/runbooks.md`.
 *
 * **Every mutating command runs on the direct connection under its own
 * advisory lock** (D27). A session lock does not hold through a transaction
 * pooler, so two containers starting together would each believe they held
 * the migration lock and both apply the same SQL.
 *
 *   bun run src/cli/index.ts migrate
 *   bun run src/cli/index.ts version
 */

import { cleanupTotal, runCleanup } from "../server/cleanup"
import { createAudit, createLogOnlyAudit } from "../server/audit"
import { createAuth } from "../server/auth/instance"
import type { IdpConfig } from "../server/config/derive"
import { loadConfig } from "../server/config/loader"
import { maskConnectionString } from "../server/config/mask"
import { createDb } from "../server/db/client"
import { runMigrations } from "../server/db/migrate"
import { loadDevEnv } from "../server/dev-env"
import { createLogger } from "../server/logger"
import type { Logger } from "../server/logger"
import { reconcileClients } from "../server/oidc/reconcile"
import { rotateKeys } from "../server/oidc/rotate-keys"
import { revision, version } from "../server/version"

const USAGE = `idp ${version}

Usage:
  idp config validate     Load and check the configuration, then exit (CFG-5)
  idp migrate             Apply pending database migrations (DM-1, OPS-6)
  idp reconcile-clients   Sync oauth_clients.jsonc into the database (FR-OIDC-2)
  idp rotate-keys         Publish a successor signing key (FR-OIDC-16)
  idp cleanup             Purge what DM-5 retires, now (OPS-8)
  idp version             Print the running version

Configuration is read from IDP_CONFIG_DIR, or /config (CFG-1).`

/**
 * Everything the database-touching commands share: config, a logger, and the
 * warnings printed once.
 *
 * `loadDevEnv()` first, because a developer's `.env` is where the connection
 * string lives and none of these commands would otherwise find it.
 */
function prepare(): { config: IdpConfig; logger: Logger } {
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
  return { config, logger }
}

async function migrate(): Promise<void> {
  const { config, logger } = prepare()

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
 * Useful when `oauth_clients.jsonc` changed and restarting the container is
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
  const { config, logger } = prepare()

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
        ? "No changes: the database already matches oauth_clients.jsonc.\n"
        : `Created ${diff.created.length}, updated ${diff.updated.length}, ` +
            `disabled ${diff.disabled.length}, deleted ${diff.deleted.length}, ` +
            `relinked ${diff.relinked.length}.\n`
    )
  } finally {
    await locking.close().catch(() => undefined)
    await database.close().catch(() => undefined)
  }
}

/**
 * Where the resolved SSL mode came from.
 *
 * The value is optional in three different ways and an operator who sees only
 * the answer cannot tell which one applied — so the answer says. `(default)`
 * is the one worth noticing: it means nothing stated a preference and the mode
 * was inferred from the host.
 */
function sslSource(config: IdpConfig): string {
  if (config.file.database.ssl !== undefined) return "  (database.ssl)"
  try {
    if (new URL(config.databaseUrl).searchParams.get("sslmode")) {
      return "  (sslmode in the connection string)"
    }
  } catch {
    /* an unparseable URL is reported elsewhere */
  }
  return "  (default for this host)"
}

/**
 * `idp config validate` — the whole of CFG-5, and nothing else (OPS-6).
 *
 * It touches no database. That is the point: an operator changing
 * `config.jsonc` wants to know whether the file is wrong *before* restarting
 * anything, and on a host that may not be able to reach Postgres at all. A
 * validation that needed a connection would be useless in exactly the
 * situation it exists for.
 *
 * Non-fatal problems print as warnings and still exit 0 — they are what CFG-5
 * calls warnings, and a deployment runs with them. A malformed file throws,
 * and the top-level handler prints the one actionable sentence.
 */
function validateConfig(): void {
  loadDevEnv()
  const { config, warnings, dir } = loadConfig()

  for (const warning of warnings) {
    process.stdout.write(`warning [${warning.code}]: ${warning.message}\n`)
  }

  process.stdout.write(
    `Configuration in ${dir} is valid.\n` +
      `  issuer      ${config.base.origin}${config.base.basePath}\n` +
      `  database    ${maskConnectionString(config.databaseUrl)}\n` +
      // D74: the two endpoints are separate settings and collapse to one when
      // a deployment has one. Printing the direct one only when it *differs*
      // says which shape this is without adding a line that repeats itself.
      (config.databaseDirectUrl === config.databaseUrl
        ? ""
        : `  direct      ${maskConnectionString(config.databaseDirectUrl)}\n`) +
      // Printed because it is *derived*, and the three inputs that decide it —
      // `database.ssl`, the connection string's `sslmode`, and whether the host
      // is local — do not agree often enough for an operator to guess. Getting
      // it wrong produces `connection is insecure` or `socket disconnected
      // before secure TLS`, neither of which names a setting.
      `  ssl         ${config.databaseSsl}${sslSource(config)}\n` +
      `  schema      ${config.file.database.schema}\n` +
      `  clients     ${config.clients.length}\n` +
      `  roles       ${config.roles.length}\n` +
      (warnings.length > 0
        ? `  warnings    ${warnings.length}\n`
        : "")
  )
}

/**
 * `idp rotate-keys` — publish a successor now, rather than waiting for the
 * interval (FR-OIDC-16, OPS-6).
 *
 * The command does not make the successor sign. `rotateKeys` publishes it and
 * backdates it behind the live key, and it takes over an hour later — long
 * enough for Neon's JWKS cache to have seen it. That hour is the entire point
 * of the mechanism (risk R11), so the output says when it happens rather than
 * reporting a rotation that has not finished.
 */
async function rotate(): Promise<void> {
  const { config, logger } = prepare()

  const database = createDb(config, { max: 2 })
  const locking = createDb(config, { direct: true, max: 2 })
  try {
    const auth = createAuth({ config, database, logger })
    await auth.$context

    const result = await rotateKeys({
      config,
      database,
      locking,
      auth,
      audit: createAudit(database, logger),
      logger,
    })

    process.stdout.write(
      `Published successor key ${result.successorKeyId}.\n` +
        (result.retiringKeyId
          ? `Key ${result.retiringKeyId} keeps signing until ${result.effectiveAt.toISOString()}.\n`
          : `It starts signing at ${result.effectiveAt.toISOString()}.\n`) +
        "Verifiers that cache the JWKS have until then to pick it up.\n"
    )
  } finally {
    await locking.close().catch(() => undefined)
    await database.close().catch(() => undefined)
  }
}

/**
 * `idp cleanup` — the retention sweep, on demand (OPS-8).
 *
 * Waits for the lock rather than skipping. The in-process job skips, because
 * it will run again in an hour and has nowhere to be; an operator who typed
 * this wants it to have happened by the time the command returns.
 */
async function cleanup(): Promise<void> {
  const { config, logger } = prepare()

  const database = createDb(config, { max: 2 })
  const locking = createDb(config, { direct: true, max: 2 })
  try {
    const counts = await runCleanup(
      { config, database, locking, logger },
      { wait: true }
    )
    if (!counts) {
      process.stdout.write("Nothing ran: another instance holds the lock.\n")
      return
    }
    const total = cleanupTotal(counts)
    process.stdout.write(
      total === 0
        ? "Nothing to purge.\n"
        : `Purged ${total} row(s):\n` +
            Object.entries(counts)
              .filter(([, value]) => value > 0)
              .map(([name, value]) => `  ${name.padEnd(22)}${value}\n`)
              .join("")
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
  const [command, ...rest] = argv

  switch (command) {
    // Two words, because `config` is a noun with more than one verb waiting
    // behind it (`config show` is the obvious next one) and `validate-config`
    // would leave no room for it.
    case "config":
      if (rest[0] !== "validate") {
        process.stderr.write(`Unknown config command: ${rest[0] ?? ""}\n\n${USAGE}\n`)
        return 1
      }
      validateConfig()
      return 0
    case "migrate":
      await migrate()
      return 0
    case "reconcile-clients":
      await reconcile()
      return 0
    case "rotate-keys":
      await rotate()
      return 0
    case "cleanup":
      await cleanup()
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
