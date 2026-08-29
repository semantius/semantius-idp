/**
 * Spike S4 (risk R8) — schema placement and Neon pooler behavior.
 *
 * Proves, against the real dev database:
 *   1. `database.schema` is honored at runtime — a fresh migrate into a
 *      non-default schema puts every table AND drizzle's journal there, and
 *      leaves `public` untouched;
 *   2. the default schema still works, so the canonical SQL is not a special case;
 *   3. re-running migrations is a no-op;
 *   4. what `search_path` actually does through the connection string in use;
 *   5. whether session-scoped advisory locks hold — the open question for
 *      Neon's `-pooler` endpoint, where transaction pooling can hand the next
 *      statement to a different backend.
 *
 *   bun run scripts/spike-s4-schema-placement.ts
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { withAdvisoryLock } from "../src/server/db/advisory-lock"
import { createDb, quoteIdentifier } from "../src/server/db/client"
import { runMigrations } from "../src/server/db/migrate"
import { deriveConfig } from "../src/server/config/derive"
import { configFileSchema } from "../src/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "../src/server/config/schema/roles-schema"

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(HERE, "..", "drizzle")

function repoEnv(): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const text = readFileSync(join(HERE, "..", "..", "..", ".env"), "utf8")
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (match)
        result[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, "")
    }
  } catch {
    /* no repo .env */
  }
  return result
}

const env = { ...repoEnv(), ...process.env }
const databaseUrl = env.DATABASE_URL
if (!databaseUrl) {
  console.error("DATABASE_URL is not set (put it in the repo-root .env).")
  process.exit(1)
}

const results: { check: string; outcome: string }[] = []
function record(check: string, outcome: string) {
  results.push({ check, outcome })
  console.log(
    `${outcome.startsWith("PASS") ? "✓" : outcome.startsWith("NOTE") ? "·" : "✗"} ${check}: ${outcome}`
  )
}

function configFor(url: string, schemaName: string) {
  return deriveConfig(
    configFileSchema.parse({
      server: { baseUrl: "http://localhost:3000" },
      secret: "s".repeat(40),
      database: { url, schema: schemaName },
      site: { name: "spike" },
      jwt: { audience: "http://localhost:3000" },
    }),
    [],
    BUILT_IN_ROLES
  )
}

async function tableNames(
  sql: ReturnType<typeof createDb>["sql"],
  schemaName: string
): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = ${schemaName} and table_type = 'BASE TABLE'
    order by table_name
  `
  return rows.map((row) => row.table_name)
}

/** One full migrate-and-inspect cycle in `schemaName`. */
async function migrateInto(schemaName: string, label: string): Promise<void> {
  const handle = createDb(configFor(databaseUrl!, schemaName), { max: 4 })
  try {
    await handle.sql.unsafe(
      `drop schema if exists ${quoteIdentifier(schemaName)} cascade`
    )
    const publicBefore = await tableNames(handle.sql, "public")

    await runMigrations(handle, { migrationsFolder: MIGRATIONS })

    const tables = await tableNames(handle.sql, schemaName)
    const publicAfter = await tableNames(handle.sql, "public")

    record(
      `${label}: every table lands in "${schemaName}"`,
      tables.length >= 17
        ? `PASS (${tables.length} tables)`
        : `FAIL (${tables.length}: ${tables.join(", ")})`
    )
    record(
      `${label}: drizzle's journal table is in "${schemaName}" too (Q16)`,
      tables.includes("__drizzle_migrations") ? "PASS" : "FAIL"
    )
    record(
      `${label}: public is untouched`,
      publicAfter.length === publicBefore.length
        ? `PASS (${publicAfter.length} pre-existing tables, unchanged)`
        : `FAIL (grew from ${publicBefore.length} to ${publicAfter.length})`
    )

    // An insert through Drizzle must reach the configured schema.
    await handle.db.insert(handle.schema.user).values({
      id: `spike-${schemaName}`,
      name: "Spike",
      email: `spike@${schemaName}.invalid`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "active",
    })
    const [count] = await handle.sql.unsafe<{ count: string }[]>(
      `select count(*)::text as count from ${quoteIdentifier(schemaName)}."user"`
    )
    record(
      `${label}: Drizzle writes into "${schemaName}"`,
      count?.count === "1" ? "PASS" : `FAIL (${count?.count})`
    )

    // Re-running must be a no-op.
    await runMigrations(handle, { migrationsFolder: MIGRATIONS })
    const [stillOne] = await handle.sql.unsafe<{ count: string }[]>(
      `select count(*)::text as count from ${quoteIdentifier(schemaName)}."user"`
    )
    record(
      `${label}: re-running migrations is a no-op`,
      stillOne?.count === "1"
        ? "PASS (data intact)"
        : `FAIL (${stillOne?.count})`
    )
  } finally {
    await handle.sql.unsafe(
      `drop schema if exists ${quoteIdentifier(schemaName)} cascade`
    )
    await handle.close()
  }
}

/** Neon's direct endpoint is the pooled hostname without the `-pooler` suffix. */
function directEndpoint(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.includes("-pooler.")) return undefined
    parsed.hostname = parsed.hostname.replace("-pooler.", ".")
    return parsed.toString()
  } catch {
    return undefined
  }
}

/**
 * Does a session-scoped advisory lock actually exclude a second holder here?
 *
 * On a pooled endpoint the answer is expected to be "no" — that is the finding
 * the spike exists to produce, so it is recorded as a verdict rather than a
 * failure. On the endpoint the IdP will actually lock through, it must be "yes".
 */
async function probeAdvisoryLocks(
  url: string,
  label: string,
  mustHold: boolean
): Promise<void> {
  const handle = createDb(configFor(url, "idp"), { max: 4 })
  try {
    let concurrentHolders = 0
    await withAdvisoryLock(handle.sql, "migrate", async () => {
      const second = await withAdvisoryLock(
        handle.sql,
        "migrate",
        async () => {
          concurrentHolders += 1
          return true
        },
        { skipIfLocked: true }
      )
      const held = second === undefined && concurrentHolders === 0
      record(
        `${label}: a session advisory lock excludes a second holder`,
        held
          ? "PASS (second attempt refused)"
          : mustHold
            ? "FAIL — the lock does not hold; this endpoint cannot be used for locked steps"
            : "NOTE the lock does NOT hold here (verdict: locked steps must use database.directUrl)"
      )
    })
    const releasedAgain = await withAdvisoryLock(
      handle.sql,
      "migrate",
      async () => "acquired",
      {
        skipIfLocked: true,
      }
    )
    record(
      `${label}: the lock is released when the critical section ends`,
      releasedAgain === "acquired" ? "PASS" : "FAIL"
    )
  } finally {
    await handle.close()
  }
}

{
  const handle = createDb(configFor(databaseUrl, "idp"), { max: 4 })
  try {
    const [version] = await handle.sql<
      { version: string }[]
    >`select version() as version`
    console.log(`\nconnected: ${version?.version.split(",")[0]}`)
    console.log(
      `endpoint:  ${databaseUrl.includes("-pooler") ? "pooled (-pooler)" : "direct"}\n`
    )

    const [searchPath] = await handle.sql<
      { search_path: string }[]
    >`show search_path`
    const searchPathApplied = searchPath?.search_path.includes("idp") ?? false
    record(
      "search_path from the connection options",
      searchPathApplied
        ? `NOTE applied (${searchPath?.search_path})`
        : `NOTE dropped by the endpoint (${searchPath?.search_path}) — harmless, every query is schema-qualified`
    )
  } finally {
    await handle.close()
  }
}

await probeAdvisoryLocks(
  databaseUrl,
  databaseUrl.includes("-pooler") ? "pooled endpoint" : "configured endpoint",
  !databaseUrl.includes("-pooler")
)

const direct = directEndpoint(databaseUrl)
if (direct) {
  await probeAdvisoryLocks(direct, "direct endpoint (database.directUrl)", true)
} else {
  record(
    "direct endpoint probe",
    "NOTE skipped — the configured URL is not a Neon pooled endpoint"
  )
}

// --- schema placement, default and configured --------------------------
await migrateInto("idp_spike_default", "canonical-name path")
await migrateInto("idp_spike_renamed", "configured-name path")

console.log("\n--- summary ---")
const failures = results.filter((entry) => entry.outcome.startsWith("FAIL"))
console.log(
  `${results.filter((r) => r.outcome.startsWith("PASS")).length} passed, ${failures.length} failed`
)
if (failures.length > 0) process.exitCode = 1
