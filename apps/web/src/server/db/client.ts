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
 * `search_path` set at connection time does not survive: a transaction pooler
 * forwards only an allow-list of startup parameters, `search_path` is not on
 * it, and nothing warns — the connection simply comes up with the default
 * path. Measured against Neon's `-pooler` endpoint. The `search_path` below is a
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
