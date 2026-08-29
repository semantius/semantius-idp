/**
 * `pnpm drizzle:reset` — drop this deployment's schema and everything in it.
 *
 * Migrations are forward-only (DM-1): there is no `down`, and no seed step to
 * re-run, so the way back to a clean database is to remove the schema and let
 * the next boot re-create it. Every path that already did this — the
 * integration harness, the S4 spike, the upgrade-rollback runbook — spells the
 * same `drop schema … cascade` out by hand against whatever connection string
 * the shell happened to have. This is that statement, aimed by the
 * *configuration the app itself would load*, so it cannot land in a database
 * the app never uses.
 *
 * Deliberately **not** an `idp` CLI command (OPS-6, **D56**). The CLI ships
 * inside the container, where a one-word command that destroys the deployment
 * is a hazard with no upside; this lives in the repository, where the developer
 * who wants a clean database is.
 *
 * What it touches: `database.schema`, and nothing else. Not `public`, not
 * another schema in the same database, not roles or extensions — Q16 and DM-4
 * exist because the IdP has to be installable into a database that belongs to
 * somebody else, and a reset that forgot that would be the loudest possible
 * violation of it.
 *
 *   bun run scripts/reset-database.ts [--yes] [--schema <name>] [--migrate]
 *
 * Afterwards the schema is gone. `pnpm dev` and the container both migrate on
 * boot (`database.migrateOnBoot`, on in the shipped config), so the next start
 * rebuilds it empty and serves the first-run setup page — there are no users,
 * so whoever completes it is the first administrator (**D52**).
 *
 * **An app that ran through the drop has to be restarted** (**D58**).
 * `lock_timeout` below was meant to be the guard here and is not: an idle
 * connection holds no table lock, so the drop succeeds against a live dev
 * server and leaves it talking to a schema that no longer exists. Worse, the
 * first-run gate memoizes `false` for the life of the process (D52,
 * `src/server/admin/first-user.ts`), so that server goes on serving the
 * *sign-in* page — the one page the person who has just reset the database is
 * certain they should not be seeing. The connection count in the target block
 * and the closing instruction both exist because that trap was walked into.
 */

import { createInterface } from "node:readline/promises"

import { loadConfig } from "../src/server/config/loader"
import { maskConnectionString } from "../src/server/config/mask"
import { createDb, quoteIdentifier } from "../src/server/db/client"
import { loadDevEnv } from "../src/server/dev-env"
import { runMigrations } from "../src/server/db/migrate"
import { createLogger } from "../src/server/logger"

/**
 * How long to wait for the locks `DROP SCHEMA … CASCADE` needs before giving
 * up. A running dev server or container holds them, and the failure mode
 * without this is a command that hangs with no output at all — which reads as
 * a broken script rather than as "stop the thing that is using it".
 */
const LOCK_TIMEOUT_SECONDS = 10

/** Postgres `lock_not_available`, which is what the timeout above produces. */
const LOCK_TIMEOUT_CODE = "55P03"

const USAGE =
  "Usage: bun run scripts/reset-database.ts [--yes] [--schema <name>] [--migrate]"

interface Options {
  yes: boolean
  migrate: boolean
  schema?: string
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { yes: false, migrate: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    switch (arg) {
      case "--yes":
      case "-y":
        options.yes = true
        break
      case "--migrate":
        options.migrate = true
        break
      case "--schema": {
        const value = argv[index + 1]
        if (!value) throw new Error(`--schema needs a schema name\n\n${USAGE}`)
        options.schema = value
        index += 1
        break
      }
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`)
    }
  }

  return options
}

/**
 * The question, with the schema named in it.
 *
 * The target block above it says which database and which schema; this asks
 * about that schema by name, so the answer is yes or no and not a transcription
 * exercise. Default is no: a bare return leaves the database alone.
 */
async function confirm(schemaName: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Not a terminal, so there is nobody to ask. Re-run with --yes if that is what you meant."
    )
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      `Drop schema "${schemaName}" and everything in it? This cannot be undone. [y/N] `
    )
    const normalized = answer.trim().toLowerCase()
    return normalized === "y" || normalized === "yes"
  } finally {
    rl.close()
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))

  loadDevEnv()
  const { config, dir } = loadConfig()
  const schemaName = options.schema ?? config.file.database.schema

  // `public` is never ours (DM-4), and dropping it would take the database's
  // extensions and everything else living there with it.
  if (schemaName === "public") {
    throw new Error(
      "Refusing to drop the `public` schema. This IdP never creates anything there."
    )
  }

  // Direct, not pooled, for the same reason every other DDL path is (D27) — a
  // transaction pooler is one more thing between this statement and the locks
  // it needs. `max: 2` because `--migrate` takes an advisory lock and then
  // queries through the same handle, which deadlocks on `max: 1`.
  const database = createDb(config, { direct: true, max: 2, schemaName })
  // The same string `createDb(…, { direct: true })` just connected with —
  // resolved in `derive.ts`, which falls back to `database.url` when a
  // deployment has one endpoint rather than two (**D74**). Printed so the
  // confirmation names the database it is about to drop a schema from.
  const url = config.databaseDirectUrl

  try {
    const [existing] = await database.sql<{ tables: number }[]>`
      select count(*)::int as tables
      from information_schema.tables
      where table_schema = ${schemaName}
    `
    const tables = existing?.tables ?? 0

    // Anything else on this database is, in a developer's shell, almost always
    // the app (D58). Counted and reported rather than refused on: this script's
    // own pool may open a second backend, and a pooler keeps idle ones around
    // after the process behind them has gone, so refusing on a non-zero count
    // would block the reset on a false positive. Saying the number is enough —
    // it turns "start the app afterwards" into "the thing you have to restart
    // is running right now".
    const [busy] = await database.sql<{ backends: number }[]>`
      select count(*)::int as backends
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
    `
    const backends = busy?.backends ?? 0

    process.stdout.write(
      `Configuration ${dir}\n` +
        `Database      ${maskConnectionString(url)}\n` +
        `Schema        ${schemaName}\n` +
        `Tables        ${tables === 0 ? "none — the schema is empty or absent" : tables}\n` +
        `Connections   ${
          backends === 0
            ? "none besides this one"
            : `${backends} other — restart whatever is using this database afterwards`
        }\n\n`
    )

    if (!options.yes && !(await confirm(schemaName))) {
      process.stdout.write("Nothing was dropped.\n")
      return 1
    }

    // Fail fast and say why, rather than blocking until somebody notices.
    await database.sql.unsafe(
      `set lock_timeout = '${LOCK_TIMEOUT_SECONDS * 1000}ms'`
    )
    try {
      await database.sql.unsafe(
        `drop schema if exists ${quoteIdentifier(schemaName)} cascade`
      )
    } catch (error) {
      if ((error as { code?: string }).code === LOCK_TIMEOUT_CODE) {
        throw new Error(
          `Timed out waiting for a lock on "${schemaName}". Something is still connected to it — ` +
            "stop the dev server (`pnpm dev`) or the container (`pnpm docker:down`), then run this again."
        )
      }
      throw error
    }

    process.stdout.write(`Dropped schema "${schemaName}".\n`)

    if (options.migrate) {
      await runMigrations(database, {
        logger: createLogger({
          level: "info",
          format: "pretty",
          base: { service: "idp-reset" },
        }),
      })
      process.stdout.write("Migrated. The schema is back, and empty.\n")
    }

    process.stdout.write(
      options.migrate || config.file.database.migrateOnBoot
        ? "\nStart the app (`pnpm dev`, or `pnpm docker:up`) and it serves the first-run\n" +
            "setup page: there are no users, so whoever completes it becomes the first\n" +
            "administrator (D52).\n" +
            "\nIf it was already running, RESTART it (D58). A process that ran through the\n" +
            "drop is talking to a schema that is no longer there, and it still believes\n" +
            "the deployment is set up — so `/` sends you to the sign-in page instead of\n" +
            "back to the wizard.\n"
        : // With `migrateOnBoot` off, start-up refuses an unmigrated database
          // and the error it prints names `idp migrate`, not this script.
          "\n`database.migrateOnBoot` is false, so the next start will refuse an unmigrated\n" +
            "database. Run `pnpm --filter web run db:migrate` first, or re-run this with --migrate.\n" +
            "\nRestart the app either way, if it ran through the drop (D58).\n"
    )

    return 0
  } finally {
    await database.close()
  }
}

try {
  process.exit(await main())
} catch (error) {
  // One actionable line, not a stack — the same contract as the CLI.
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
}
