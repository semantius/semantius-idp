import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "drizzle-kit"

/**
 * drizzle-kit configuration (DM-1, DM-4, risk R8).
 *
 * It sits next to the schema it describes rather than at the repo root, because
 * both the generated schema and the migrations the runtime reads live in
 * `apps/web` and drizzle-kit resolves every path relative to this file.
 *
 * `migrations.schema` is the important line: without it drizzle's own
 * bookkeeping table lands in `public`, which Q16/DM-4 forbid — the IdP must be
 * installable into a database whose `public` schema belongs to someone else.
 *
 * Only `pnpm --filter web run db:generate` uses this. The runtime migrator
 * (`idp migrate`, and boot when `database.migrateOnBoot` is on) reads
 * `database.url` from the configuration instead, under an advisory lock.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * drizzle-kit is invoked with `apps/web` as its working directory, so the
 * repo-root `.env` a developer keeps is not picked up automatically.
 */
function loadRepoEnv(): void {
  if (process.env.DATABASE_URL) return
  try {
    const text = readFileSync(join(HERE, "..", "..", ".env"), "utf8")
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!match) continue
      const value = match[2]!.trim().replace(/^["']|["']$/g, "")
      process.env[match[1]!] ??= value
    }
  } catch {
    // No repo-level .env; the caller is expected to export DATABASE_URL.
  }
}

loadRepoEnv()

const schemaName = process.env.IDP_SCHEMA_NAME ?? "idp"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/auth-schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/idp",
  },
  // Never look at, diff against, or touch anything outside our own schema.
  schemaFilter: [schemaName],
  migrations: {
    schema: schemaName,
    table: "__drizzle_migrations",
  },
  strict: true,
  verbose: true,
})
