/**
 * Postgres connection and Drizzle instance (DM-4, CFG-4 `database.*`).
 *
 * Everything the IdP owns lives in one schema — `database.schema`, default
 * `idp` — and nothing is created in `public`. The schema name is a runtime
 * value, so the tables are built here by calling the generated factory with it
 * rather than being captured at module load; the migrator rewrites the same
 * identifier in the committed SQL.
 *
 * Table names are always schema-qualified in the SQL Drizzle emits, which is
 * what makes this work through a transaction-mode connection pooler, where a
 * `search_path` set at connection time does not survive (see
 * `docs/spikes/s4-schema-placement.md`). The `search_path` below is a
 * convenience for hand-written SQL and psql sessions, never something the
 * runtime depends on.
 */

import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import type { IdpConfig } from "../config/derive"
import { createAuthSchema } from "./schema/auth-schema"
import type { AuthSchema } from "./schema/auth-schema"

export type Database = ReturnType<typeof drizzle<AuthSchema>>

export interface DbHandle {
  db: Database
  sql: postgres.Sql
  /** The tables, bound to `schemaName`. */
  schema: AuthSchema
  /** The schema every table lives in. */
  schemaName: string
  close: () => Promise<void>
}

export interface CreateDbOptions {
  /** Overrides `database.url`. */
  url?: string
  /** Overrides `database.schema`; the integration harness gives each file its own. */
  schemaName?: string
  /** Overrides `database.poolMax`. One connection is right for migrations and the CLI. */
  max?: number
  /**
   * Use `database.directUrl` when it is set.
   *
   * Session-scoped advisory locks do not hold through a transaction-mode
   * connection pooler — verified against Neon's `-pooler` endpoint, where a
   * second `pg_try_advisory_lock` on a different connection succeeds while the
   * first still holds it. Every step that takes a lock (startup, migrations,
   * the CLI, the cleanup job) must therefore connect directly.
   */
  direct?: boolean
}

/**
 * Reads a `timestamp without time zone` as the UTC instant it was written as.
 *
 * **Every timestamp column in the auth schema is `timestamp`, not
 * `timestamptz`** — that is what Better Auth's generator emits and what
 * `auth-schema.ts` therefore says, and it is not ours to change by hand. So
 * the column carries a wall clock with no zone attached, and the zone it
 * means is decided entirely by who writes it and who reads it.
 *
 * The write side is already UTC: postgres.js serialises a `Date` with
 * `toISOString()`, and Postgres discards the offset when the target is
 * `timestamp without time zone`, so `19:58Z` is stored as the literal `19:58`.
 * **The read side was not.** postgres.js parses oid 1114 with plain
 * `new Date(x)` on a string like `2026-08-27 19:58:38.81`, which JavaScript
 * resolves in the *process's* zone — and Drizzle, which does append `+0000`
 * for exactly this reason, never sees it, because `mapFromDriverValue`
 * returns a non-string through untouched.
 *
 * The result is that every timestamp read out of the database arrives shifted
 * by the local UTC offset, and always into the past for a zone east of
 * Greenwich. Anything that compares one to `Date.now()` is then wrong by that
 * much: the freshness gate (`http/fresh-session.ts`, FR-AUTH-5) is the loudest
 * — with `session.freshAgeMinutes` at 15 and a machine on UTC+1, a session
 * that was seconds old measured an hour and one minute, so **every** sensitive
 * action bounced to `/login?notice=reauth…` and re-authenticating produced
 * another session that was just as stale. Reported that way on 2026-08-27:
 * a re-authentication demanded ten seconds after the page was opened.
 *
 * `docker/Dockerfile` sets `TZ=UTC`, so the image, the e2e suite and CI are
 * all immune — this is only ever visible to a developer whose machine is not
 * on UTC, which is why no gate here has ever seen it (**D79**).
 *
 * Only oid 1114 is overridden. 1082 (`date`) has no time to misplace and
 * 1184 (`timestamptz`) already arrives with an offset; both keep postgres.js's
 * own parser.
 */
export function parseTimestampUtc(value: string): Date {
  // `infinity` / `-infinity` are not dates and must stay whatever the default
  // made of them (an invalid `Date`) rather than becoming one an hour off.
  if (!/^\d/.test(value)) return new Date(value)
  return new Date(`${value.replace(" ", "T")}Z`)
}

/**
 * Heuristic for "this connection string goes through a transaction pooler".
 * Used only to warn — the fix is always an explicit `database.directUrl`.
 */
export function looksPooled(url: string): boolean {
  try {
    const { hostname, searchParams } = new URL(url)
    return (
      hostname.includes("-pooler.") ||
      hostname.startsWith("pgbouncer") ||
      searchParams.get("pgbouncer") === "true"
    )
  } catch {
    return false
  }
}

function sslOption(config: IdpConfig): postgres.Options<{}>["ssl"] {
  switch (config.databaseSsl) {
    case "disable":
      return false
    case "verify-full":
      return config.file.database.sslCa
        ? { ca: config.file.database.sslCa, rejectUnauthorized: true }
        : { rejectUnauthorized: true }
    case "require":
    default:
      // `require` means "encrypt", not "verify" — the certificate chain is not
      // checked. That is the Postgres meaning of the word and matches what a
      // connection string's `sslmode=require` does.
      return config.file.database.sslCa
        ? { ca: config.file.database.sslCa, rejectUnauthorized: false }
        : { rejectUnauthorized: false }
  }
}

/**
 * Opens a connection pool. The caller owns it and must `close()` it — the
 * server does so on SIGTERM (OPS-4), the CLI when its command finishes.
 */
export function createDb(
  config: IdpConfig,
  options: CreateDbOptions = {}
): DbHandle {
  const schemaName = options.schemaName ?? config.file.database.schema
  // Both are resolved in `derive.ts` and each already falls back to the other
  // (**D74**), so a single-endpoint deployment gets the same string either
  // way and this does not need to know which shape it is looking at.
  const url =
    options.url ??
    (options.direct ? config.databaseDirectUrl : config.databaseUrl)
  const schema = createAuthSchema(schemaName)

  const sql = postgres(url, {
    max: options.max ?? config.file.database.poolMax,
    connect_timeout: config.file.database.connectTimeoutSeconds,
    ssl: sslOption(config),
    // Best-effort only: a pooler may drop this startup parameter. Every query
    // Drizzle emits is schema-qualified, so nothing depends on it.
    connection: { search_path: `${schemaName}, public` },
    // Postgres notices are operational noise on a healthy system; real errors
    // arrive as rejected promises.
    onnotice: () => {},
    prepare: false,
    // **D79**: a `timestamp without time zone` is written as UTC and must be
    // read back as UTC. See `parseTimestampUtc`.
    types: {
      timestamp: {
        to: 1114,
        from: [1114],
        serialize: (x: Date | string) =>
          (x instanceof Date ? x : new Date(x)).toISOString(),
        parse: parseTimestampUtc,
      },
    },
  })

  const db = drizzle(sql, { schema })

  return {
    db,
    sql,
    schema,
    schemaName,
    close: async () => {
      await sql.end({ timeout: 5 })
    },
  }
}

/** `CREATE SCHEMA IF NOT EXISTS`, run before the first migration. */
export async function ensureSchema(
  sql: postgres.Sql,
  schemaName: string
): Promise<void> {
  await sql.unsafe(`create schema if not exists ${quoteIdentifier(schemaName)}`)
}

/** Quotes a Postgres identifier. Schema names are validated by the config schema first. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
