/**
 * Generates `src/server/db/schema/auth-schema.ts` from the *installed* Better
 * Auth (DM-1, DM-4, risk R8).
 *
 * DM-1 asks for the schema to be generated from the enabled plugins rather than
 * hand-written, with CI failing on drift. The obvious tool — `@better-auth/cli
 * generate` — cannot be used: its `latest` is 1.4.21 and it depends on
 * `better-auth@1.4.21` as a hard dependency, so it would derive the core tables
 * from a different major-minor than the 1.7.1 our plugins come from. That is
 * exactly the drift the gate exists to catch, so the generator lives here
 * instead and reads `getAuthTables()` from the version we actually run.
 *
 * Every table is emitted inside `pgSchema(database.schema)` (default `idp`), so
 * nothing lands in `public` and drizzle-kit qualifies its DDL — no
 * post-processing step is needed.
 *
 *   bun run scripts/generate-auth-schema.ts [--check]
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { format, resolveConfig } from "prettier"

import { getAuthTables } from "@better-auth/core/db"
import {
  getDatabaseFieldIndexName,
  resolveDatabaseSchemaIndexes,
} from "@better-auth/core/db/internal"

import type { DBFieldAttribute } from "@better-auth/core/db"

import { createAuthOptions } from "../src/server/auth/instance"
import { schemaGenerationConfig } from "../src/server/config/schema-generation-config"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(
  HERE,
  "..",
  "src",
  "server",
  "db",
  "schema",
  "auth-schema.ts"
)

const HEADER = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by \`bun run scripts/generate-auth-schema.ts\` from the installed
 * Better Auth and the plugin list in \`src/server/auth/instance.ts\` (DM-1).
 * CI regenerates it and fails on any difference, so the committed migrations
 * can never describe a schema the running code does not expect.
 *
 * Every table is scoped to a Postgres schema (DM-4). The name is a *runtime*
 * value — \`database.schema\`, default \`idp\` — so the tables come from a
 * factory the database client calls once, and the migrator rewrites the
 * canonical schema identifier in the committed SQL to match.
 */
`

interface TableIndex {
  type: "index" | "uniqueIndex"
  name: string
  on: string[]
}

function snakeCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
}

/**
 * Postgres column for one Better Auth field. Mirrors the mapping the Drizzle
 * adapter itself uses at runtime, which is what makes the generated schema and
 * the adapter agree.
 */
function columnType(name: string, field: DBFieldAttribute): string {
  if (field.references?.field === "id") return `text("${name}")`

  const type = field.type
  if (Array.isArray(type)) {
    return `text("${name}", { enum: [${type.map((value) => JSON.stringify(value)).join(", ")}] })`
  }

  switch (type) {
    case "string":
      return `text("${name}")`
    case "boolean":
      return `boolean("${name}")`
    case "number":
      return field.bigint
        ? `bigint("${name}", { mode: "number" })`
        : `integer("${name}")`
    case "date":
      return `timestamp("${name}")`
    case "string[]":
      return `text("${name}").array()`
    case "number[]":
      return field.bigint
        ? `bigint("${name}", { mode: "number" }).array()`
        : `integer("${name}").array()`
    case "json":
      return `jsonb("${name}")`
    default:
      throw new Error(
        `Unsupported Better Auth field type "${String(type)}" on column "${name}".`
      )
  }
}

function defaultClause(field: DBFieldAttribute): string {
  const value = field.defaultValue
  if (value === undefined || value === null) return ""
  if (typeof value === "function") {
    // The only function default Better Auth uses is `() => new Date()`.
    return field.type === "date" && value.toString().includes("new Date()")
      ? ".defaultNow()"
      : ""
  }
  if (Array.isArray(value))
    return `.default([${value.map((item) => JSON.stringify(item)).join(", ")}])`
  if (typeof value === "object") return `.default(${JSON.stringify(value)})`
  return `.default(${JSON.stringify(value)})`
}

function generate(schemaName: string): string {
  const options = createAuthOptions({ config: schemaGenerationConfig() })
  const tables = getAuthTables(options)

  const migratable = Object.entries(tables).filter(
    ([, table]) => !table.disableMigrations
  )

  const resolvedIndexes = resolveDatabaseSchemaIndexes(
    migratable.map(([, table]) => ({
      fields: table.fields,
      indexes: table.indexes,
      tableName: table.modelName,
    }))
  )

  const usedColumnTypes = new Set<string>()
  const bodies: string[] = []
  const tableNames: string[] = []

  for (const [tableKey, table] of migratable) {
    const modelName = table.modelName
    const indexes: TableIndex[] = []

    for (const resolved of resolvedIndexes.get(modelName) ?? []) {
      indexes.push({
        type: resolved.unique ? "uniqueIndex" : "index",
        name: resolved.name,
        on: [...resolved.columns],
      })
    }

    const columns: string[] = [`  id: text("id").primaryKey(),`]

    for (const [fieldKey, field] of Object.entries(table.fields)) {
      const columnName = field.fieldName ?? fieldKey
      const dbName = snakeCase(columnName)

      let definition = columnType(dbName, field)
      usedColumnTypes.add(definition.slice(0, definition.indexOf("(")))

      definition += defaultClause(field)
      if (field.required) definition += ".notNull()"
      if (field.unique) definition += ".unique()"
      if (field.references) {
        const target = tables[field.references.model]
        if (!target) {
          throw new Error(
            `Field "${modelName}.${columnName}" references unknown model "${field.references.model}".`
          )
        }
        const targetField = field.references.field || "id"
        definition +=
          `.references(() => ${target.modelName}.${targetField}, ` +
          `{ onDelete: "${field.references.onDelete ?? "cascade"}" })`
      }

      if (field.index) {
        indexes.push({
          type: field.unique ? "uniqueIndex" : "index",
          name: getDatabaseFieldIndexName(
            modelName,
            columnName,
            Boolean(field.unique)
          ),
          on: [columnName],
        })
      }

      columns.push(`  ${columnName}: ${definition},`)
    }

    const indexClause =
      indexes.length === 0
        ? ""
        : `, (table) => [\n${dedupeIndexes(indexes)
            .map(
              (index) =>
                `  ${index.type}(${JSON.stringify(index.name)}).on(${index.on.map((column) => `table.${column}`).join(", ")}),`
            )
            .join("\n")}\n]`

    bodies.push(
      `  const ${modelName} = idpSchema.table("${snakeCase(modelName)}", {\n${indent(columns.join("\n"))}\n  }${indent(indexClause)})`
    )
    tableNames.push(modelName)
    void tableKey
  }

  const drizzleImports = [...usedColumnTypes].sort()
  const indexImports = bodies.some((body) => body.includes("uniqueIndex("))
    ? ["uniqueIndex"]
    : []
  if (bodies.some((body) => body.includes(" index(")))
    indexImports.push("index")

  const importList = ["pgSchema", ...drizzleImports, ...indexImports].sort()

  return (
    HEADER +
    `\nimport { ${importList.join(", ")} } from "drizzle-orm/pg-core"\n` +
    `
/**
 * The schema name the committed migrations are written against. The runtime
 * migrator rewrites this identifier when \`database.schema\` differs, so it is a
 * canonical value in the SQL, not a hard-coded deployment decision.
 */
export const CANONICAL_SCHEMA_NAME = ${JSON.stringify(schemaName)}

/**
 * Builds every table inside \`schemaName\` (CFG-4 \`database.schema\`, DM-4).
 *
 * Drizzle needs the schema name when the table is *defined*, so the tables are
 * produced by a factory the database client calls once with the configured
 * name, rather than captured at module load from a constant.
 */
export function createAuthSchema(schemaName: string) {
  const idpSchema = pgSchema(schemaName)

${bodies.join("\n\n")}

  return { idpSchema, ${tableNames.join(", ")} }
}

export type AuthSchema = ReturnType<typeof createAuthSchema>

/**
 * A default instance under the canonical name. drizzle-kit needs statically
 * exported tables to diff against, and \`db:generate\` runs with the canonical
 * name so the committed SQL is canonical too.
 */
const canonicalSchema = createAuthSchema(process.env.IDP_DB_SCHEMA ?? CANONICAL_SCHEMA_NAME)

export const { idpSchema, ${tableNames.join(", ")} } = canonicalSchema
`
  )
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n")
}

/** A field-level and a table-level index can describe the same thing; keep one. */
function dedupeIndexes(indexes: TableIndex[]): TableIndex[] {
  const seen = new Map<string, TableIndex>()
  for (const index of indexes) {
    const key = `${index.type}:${index.on.join(",")}`
    if (!seen.has(key)) seen.set(key, index)
  }
  return [...seen.values()]
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check")
  const schemaName = "idp"
  // The generator owns the formatting: `--check` compares byte-for-byte, so the
  // committed file and a fresh run have to agree even after someone runs
  // prettier over the tree.
  const next = await format(generate(schemaName), {
    ...(await resolveConfig(OUT_PATH)),
    parser: "typescript",
  })

  if (check) {
    let current = ""
    try {
      current = readFileSync(OUT_PATH, "utf8")
    } catch {
      current = ""
    }
    if (current.replace(/\r\n/g, "\n") !== next) {
      process.stderr.write(
        "The committed Drizzle schema no longer matches the installed Better Auth " +
          "(DM-1 drift).\nRun `pnpm --filter web run db:generate-schema`, then " +
          "`pnpm --filter web run db:generate`, and commit both.\n"
      )
      process.exit(1)
    }
    process.stdout.write("Drizzle schema is up to date.\n")
    return
  }

  writeFileSync(OUT_PATH, next, "utf8")
  process.stdout.write(`wrote ${OUT_PATH}\n`)
}

await main()
