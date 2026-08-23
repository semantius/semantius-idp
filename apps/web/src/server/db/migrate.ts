/**
 * Runtime migrations (OPS-5, DM-4, CFG-4 `database.schema`).
 *
 * Forward-only, applied on boot when `database.migrateOnBoot` is set and
 * otherwise by `idp migrate`. Always under an advisory lock, so two containers
 * starting at the same moment cannot both apply the same migration.
 *
 * ## Why this is not `drizzle-orm`'s migrator
 *
 * `database.schema` is a runtime setting, but the committed SQL is generated
 * ahead of time and names its schema literally. Drizzle's migrator applies the
 * file as-is, so a deployment that sets `database.schema: "auth"` would still
 * get tables in `idp`. This runner does the one extra thing that is needed:
 * it rewrites the canonical schema identifier before executing, and it verifies
 * the rewrite rather than trusting a regex.
 *
 * The bookkeeping table keeps drizzle's name and shape (`__drizzle_migrations`
 * with `hash` + `created_at`), so `drizzle-kit` tooling still understands a
 * database this runner has migrated.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { DbHandle } from "./client"
import { ensureSchema, quoteIdentifier } from "./client"
import { CANONICAL_SCHEMA_NAME } from "./schema/auth-schema"
import { withAdvisoryLock } from "./advisory-lock"
import type { Logger } from "../logger"

export const MIGRATIONS_TABLE = "__drizzle_migrations"

/** drizzle-kit writes one statement per `--> statement-breakpoint`. */
const STATEMENT_BREAKPOINT = "--> statement-breakpoint"

interface JournalEntry {
  idx: number
  tag: string
  when: number
}

interface Migration {
  tag: string
  hash: string
  statements: string[]
}

/**
 * Where the committed SQL lives. Resolved from this module so it works from
 * `src` in development and from the bundle in the image, where the folder is
 * copied next to the server entry point.
 */
export function defaultMigrationsFolder(): string {
  if (process.env.IDP_MIGRATIONS_DIR) return process.env.IDP_MIGRATIONS_DIR
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, "..", "..", "..", "drizzle")
}

/**
 * Retargets the canonical schema identifier.
 *
 * Only quoted identifiers in a schema position are touched — `"idp".` and
 * `SCHEMA "idp"` — so an ordinary occurrence of the word in a comment or a
 * seeded value cannot be caught by accident. The caller checks the count.
 */
export function retargetSchema(
  sql: string,
  schemaName: string
): { sql: string; replacements: number } {
  // `ensureSchema` has already created the schema, so the generated
  // `CREATE SCHEMA` has to tolerate it existing. Doing this unconditionally
  // keeps the default and the retargeted path on exactly the same code.
  let rewritten = sql.replace(
    /\bCREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS)/gi,
    "CREATE SCHEMA IF NOT EXISTS "
  )

  if (schemaName === CANONICAL_SCHEMA_NAME)
    return { sql: rewritten, replacements: 0 }

  const canonical = CANONICAL_SCHEMA_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const target = quoteIdentifier(schemaName)
  let replacements = 0

  const qualified = new RegExp(`"${canonical}"(?=\\.)`, "g")
  const created = new RegExp(
    `(?<=\\bSCHEMA\\s)(?:IF\\s+NOT\\s+EXISTS\\s+)?"${canonical}"`,
    "gi"
  )

  rewritten = rewritten
    .replace(qualified, () => {
      replacements += 1
      return target
    })
    .replace(created, (match) => {
      replacements += 1
      return match.toUpperCase().startsWith("IF")
        ? `IF NOT EXISTS ${target}`
        : target
    })

  return { sql: rewritten, replacements }
}

export function readMigrations(folder: string): Migration[] {
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8")
  ) as {
    entries: JournalEntry[]
  }

  return journal.entries
    .slice()
    .sort((left, right) => left.idx - right.idx)
    .map((entry) => {
      const sql = readFileSync(join(folder, `${entry.tag}.sql`), "utf8")
      return {
        tag: entry.tag,
        // Same hash drizzle's own migrator records, so the two agree on which
        // migrations have already run.
        hash: createHash("sha256").update(sql).digest("hex"),
        statements: sql
          .split(STATEMENT_BREAKPOINT)
          .map((statement) => statement.trim())
          .filter((statement) => statement !== ""),
      }
    })
}

export interface MigrateOptions {
  migrationsFolder?: string
  logger?: Logger
  /** Skip the advisory lock. Only the integration harness, which owns its schema, does this. */
  unlocked?: boolean
}

export async function runMigrations(
  handle: DbHandle,
  options: MigrateOptions = {}
): Promise<void> {
  const folder = options.migrationsFolder ?? defaultMigrationsFolder()
  const migrations = readMigrations(folder)

  const apply = async () => {
    await ensureSchema(handle.sql, handle.schemaName)
    await ensureMigrationsTable(handle)

    const applied = await appliedHashes(handle)
    const pending = migrations.filter(
      (migration) => !applied.has(migration.hash)
    )

    if (pending.length === 0) {
      options.logger?.debug("no pending migrations", {
        schema: handle.schemaName,
      })
      return
    }

    for (const migration of pending) {
      // One transaction per migration: Postgres DDL is transactional, so a
      // failure leaves no half-created schema behind.
      await handle.sql.begin(async (tx) => {
        for (const statement of migration.statements) {
          const { sql: retargeted } = retargetSchema(
            statement,
            handle.schemaName
          )
          await tx.unsafe(retargeted)
        }
        await tx.unsafe(
          `insert into ${quoteIdentifier(handle.schemaName)}.${quoteIdentifier(MIGRATIONS_TABLE)} (hash, created_at) values ($1, $2)`,
          [migration.hash, Date.now()]
        )
      })
      options.logger?.info("migration applied", {
        tag: migration.tag,
        schema: handle.schemaName,
      })
    }

    options.logger?.info("migrations up to date", {
      schema: handle.schemaName,
      applied: pending.length,
      total: migrations.length,
    })
  }

  if (options.unlocked) {
    await apply()
  } else {
    await withAdvisoryLock(handle.sql, "migrate", apply, {
      timeoutSeconds: 120,
    })
  }
}

/**
 * Whether every committed migration has been applied — the migration half of
 * `GET /readyz` (OPS-3).
 */
export async function migrationsAreCurrent(
  handle: DbHandle,
  options: { migrationsFolder?: string } = {}
): Promise<boolean> {
  let expected: Migration[]
  try {
    expected = readMigrations(
      options.migrationsFolder ?? defaultMigrationsFolder()
    )
  } catch {
    return false
  }

  try {
    const applied = await appliedHashes(handle)
    return expected.every((migration) => applied.has(migration.hash))
  } catch {
    // The bookkeeping table does not exist yet: nothing has been migrated.
    return false
  }
}

async function ensureMigrationsTable(handle: DbHandle): Promise<void> {
  await handle.sql.unsafe(`
    create table if not exists ${quoteIdentifier(handle.schemaName)}.${quoteIdentifier(MIGRATIONS_TABLE)} (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `)
}

async function appliedHashes(handle: DbHandle): Promise<Set<string>> {
  const rows = await handle.sql.unsafe<{ hash: string }[]>(
    `select hash from ${quoteIdentifier(handle.schemaName)}.${quoteIdentifier(MIGRATIONS_TABLE)}`
  )
  return new Set(rows.map((row) => row.hash))
}
