/**
 * Which migrations count as having run.
 *
 * Replays the persistent dev schema as it stood on 2026-09-11, the day the
 * first boot after `523ecfe` answered every page with a 500. Its bookkeeping
 * table held 0000 and 0001 under the hash of a CRLF checkout — Windows, with
 * `core.autocrlf=true` and no `.gitattributes` — and 0003 under the hash of a
 * version that had since been reverted and regenerated under the same tag. The
 * runner hashed the file as it sat on disk, so once the working tree went LF it
 * saw four pending migrations, ran 0000 again, and stopped at
 * `relation "account" already exists`.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { quoteIdentifier } from "@/server/db/client"
import {
  MIGRATIONS_TABLE,
  migrationsAreCurrent,
  readMigrations,
  runMigrations,
} from "@/server/db/migrate"
import { createTestContext } from "./harness"
import type { TestContext } from "./harness"

const FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "drizzle"
)

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** The hash a CRLF checkout of this migration recorded. */
function crlfHash(tag: string): string {
  const lf = readFileSync(join(FOLDER, `${tag}.sql`), "utf8").replace(
    /\r\n/g,
    "\n"
  )
  return sha256(lf.replace(/\n/g, "\r\n"))
}

describe("migrations already recorded under another form", () => {
  let context: TestContext
  let table: string

  beforeEach(async () => {
    context = await createTestContext("migrate")
    table = `${quoteIdentifier(context.schemaName)}.${quoteIdentifier(MIGRATIONS_TABLE)}`
  })

  afterEach(async () => {
    await context.teardown()
  })

  async function recordedCount(): Promise<number> {
    const [row] = await context.database.sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from ${table}`
    )
    return row?.n ?? 0
  }

  async function columns(tableName: string): Promise<string[]> {
    const rows = await context.database.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${context.schemaName} and table_name = ${tableName}`
    return rows.map((row) => row.column_name)
  }

  it("does not run one again because it was recorded from a CRLF checkout", async () => {
    const migrations = readMigrations(FOLDER)
    for (const migration of migrations) {
      await context.database.sql.unsafe(
        `update ${table} set hash = $1 where hash = $2`,
        [crlfHash(migration.tag), migration.hash]
      )
    }

    await runMigrations(context.database, {
      migrationsFolder: FOLDER,
      unlocked: true,
    })

    expect(await recordedCount()).toBe(migrations.length)
    await expect(
      migrationsAreCurrent(context.database, { migrationsFolder: FOLDER })
    ).resolves.toBe(true)
  })

  it("applies the one rewritten after it ran, and nothing else", async () => {
    const migrations = readMigrations(FOLDER)
    const rewritten = migrations.find(
      (migration) => migration.tag === "0003_strange_wallop"
    )
    if (!rewritten) throw new Error("0003_strange_wallop is not in the journal")

    // 0000 and 0001 as CRLF, 0002 as LF: the persistent schema's rows exactly.
    for (const tag of ["0000_familiar_slipstream", "0001_cheerful_korg"]) {
      const migration = migrations.find((entry) => entry.tag === tag)
      await context.database.sql.unsafe(
        `update ${table} set hash = $1 where hash = $2`,
        [crlfHash(tag), migration?.hash ?? ""]
      )
    }
    // 0003 as the version that ran on 2026-08-29 and was later replaced:
    // `trust_proxy` where the committed file adds `audience`.
    await context.database.sql.unsafe(
      `update ${table} set hash = $1 where hash = $2`,
      [sha256("the reverted trust_proxy version"), rewritten.hash]
    )
    await context.database.sql.unsafe(
      `alter table ${quoteIdentifier(context.schemaName)}."gateway" drop column "audience", add column "trust_proxy" boolean default false`
    )

    await runMigrations(context.database, {
      migrationsFolder: FOLDER,
      unlocked: true,
    })

    // Only the rewritten one ran: its column is back and one row was added.
    expect(await columns("gateway")).toContain("audience")
    expect(await columns("gateway")).toContain("trust_proxy")
    expect(await recordedCount()).toBe(migrations.length + 1)
    await expect(
      migrationsAreCurrent(context.database, { migrationsFolder: FOLDER })
    ).resolves.toBe(true)
  })
})

/**
 * Leaving the account shape Better Auth 1.7.0–1.7.2 had.
 *
 * Every deployment up to v0.6.8 ran 1.7.1, whose `account` carried a NOT NULL
 * `issuer` and a unique index on `(issuer, account_id)`; 1.7.3 reverted both,
 * and the migration that follows drops them and puts a unique index on
 * `(provider_id, account_id)` in their place. Every other test starts from an
 * empty schema, so none of them shows that the new index can be built over the
 * rows a live deployment already holds — which is the only way it can fail,
 * and it would fail at boot.
 */
describe("the account issuer column, on a database that has accounts", () => {
  let context: TestContext

  beforeEach(async () => {
    context = await createTestContext("migrate-issuer")
  })

  afterEach(async () => {
    await context.teardown()
  })

  it("drops it, keeps every row, and refuses a second account for one identity", async () => {
    const schema = quoteIdentifier(context.schemaName)
    const sql = context.database.sql
    const migration = readMigrations(FOLDER).find(
      (entry) => entry.tag === "0004_wet_gambit"
    )
    if (!migration) throw new Error("0004_wet_gambit is not in the journal")

    // The table as 1.7.1 left it, and 0004 not yet recorded.
    await sql.unsafe(
      `drop index ${schema}."account_providerId_accountId_uidx";
       alter table ${schema}."account" add column "issuer" text;
       create unique index "account_issuer_accountId_uidx"
         on ${schema}."account" ("issuer", "account_id");
       delete from ${schema}.${quoteIdentifier(MIGRATIONS_TABLE)}
         where hash = '${migration.hash}'`
    )

    const auth = await context.auth.$context
    const user = await createUserWithoutRequest(auth, {
      email: "issuer@example.com",
      name: "Issuer",
      emailVerified: true,
    })
    // A password account and a social one, with the issuer values 1.7.1 wrote.
    await sql.unsafe(
      `insert into ${schema}."account"
         (id, account_id, provider_id, user_id, issuer, created_at, updated_at)
       values
         ('acc-credential', $1, 'credential', $1, 'local:credential', now(), now()),
         ('acc-social', 'oid-123', 'microsoft',
          $1, 'https://login.microsoftonline.com/tenant/v2.0', now(), now())`,
      [user.id]
    )
    await sql.unsafe(
      `alter table ${schema}."account" alter column "issuer" set not null`
    )

    await runMigrations(context.database, {
      migrationsFolder: FOLDER,
      unlocked: true,
    })

    const accountColumns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${context.schemaName} and table_name = 'account'`
    expect(accountColumns.map((row) => row.column_name)).not.toContain("issuer")
    const rows = await sql.unsafe<{ id: string }[]>(
      `select id from ${schema}."account" order by id`
    )
    expect(rows.map((row) => row.id)).toEqual(["acc-credential", "acc-social"])

    // The race the index exists for: the same identity linked twice.
    await expect(
      sql.unsafe(
        `insert into ${schema}."account"
           (id, account_id, provider_id, user_id, created_at, updated_at)
         values ('acc-twice', 'oid-123', 'microsoft', $1, now(), now())`,
        [user.id]
      )
    ).rejects.toMatchObject({ code: "23505" })
  })
})
