/**
 * Generates `src/server/db/schema/auth-schema.ts` from the *installed* Better
 * Auth (DM-1, DM-4, risk R8).
 *
 * DM-1 asks for the schema to be generated from the enabled plugins rather than
 * hand-written, with CI failing on drift, and names `@better-auth/cli generate`
 * as the tool. **That justification used to be recorded here as "the CLI is
 * version-stranded at 1.4.21". It was wrong** — `@better-auth/cli` is
 * deprecated and the CLI was renamed to `auth`, which publishes 1.7.1 and
 * depends on `better-auth@1.7.1` and `@better-auth/core@1.7.1`: exactly our
 * pins. Recorded as **D29**; see `docs/spikes/s5-client-fields-and-claims.md`.
 *
 * The real reason this file survives is narrower and structural. Run against a
 * shim exporting our own option set, `auth generate` produces the same
 * seventeen tables with the same fields — but as **module-level constants**.
 * Where a Postgres schema is configured it emits, from its own source:
 *
 *     code += `
export const ${schemaVarName} = pgSchema(${JSON.stringify(schemaName)});

`
 *
 * — the schema name baked in as a string literal at generate time. D27 and
 * DM-4 make `database.schema` a **runtime** value, so the module has to be a
 * `createAuthSchema(schemaName)` factory plus `CANONICAL_SCHEMA_NAME` for the
 * migrator to retarget. The CLI has no code path that emits a function, so it
 * cannot produce the shape the runtime needs. Hence: same source of truth
 * (`getAuthTables()`), different emitter.
 *
 * Running the CLI was worth it regardless — diffing its output against ours
 * found two real defects in this file, both fixed below and both marked.
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

/**
 * The schema name the committed file and the committed migrations are written
 * against. `database.schema` retargets both at runtime (D27, DM-4), so this is
 * a canonical value in the artifacts, never a deployment decision.
 */
const CANONICAL_SCHEMA_NAME = "idp"

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
    // Call it rather than match its source. The previous test looked for the
    // literal `new Date()` and Better Auth 1.7.1 writes `() => new Date` —
    // no parentheses — so every `.defaultNow()` was being dropped on the
    // floor. These defaults are Better Auth's own thunks and have no side
    // effects; anything we cannot evaluate is something we cannot express as
    // DDL either.
    try {
      const produced = (value as () => unknown)()
      if (produced instanceof Date) return ".defaultNow()"
    } catch {
      /* not expressible */
    }
    return ""
  }
  if (Array.isArray(value))
    return `.default([${value.map((item) => JSON.stringify(item)).join(", ")}])`
  if (typeof value === "object") return `.default(${JSON.stringify(value)})`
  return `.default(${JSON.stringify(value)})`
}

/**
 * `.$onUpdate(...)` for a field the plugin declares as touch-on-write.
 *
 * Drizzle applies this in JavaScript on its own `.update()`, so it changes no
 * DDL and no migration — but leaving it out meant a row updated through
 * Drizzle kept a stale `updated_at`, which is not what the plugin declared.
 * `session.updatedAt` and `account.updatedAt` are the two that carry it.
 */
function onUpdateClause(field: DBFieldAttribute): string {
  const onUpdate = (field as { onUpdate?: unknown }).onUpdate
  if (typeof onUpdate !== "function" || field.type !== "date") return ""
  try {
    if ((onUpdate as () => unknown)() instanceof Date) {
      return ".$onUpdate(() => new Date())"
    }
  } catch {
    /* not expressible */
  }
  return ""
}

function generate(schemaName: string): string {
  // `forSchema` keeps the config-gated plugins (2FA, API keys) registered
  // whatever a config file says: the generated schema must depend on the
  // plugin list alone, or two deployments would need different migrations
  // and this gate would mean nothing.
  const options = createAuthOptions({
    config: schemaGenerationConfig(),
    forSchema: true,
  })
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
      // `DBFieldAttribute.required` is documented `@default true`, so only an
      // explicit `false` makes a column nullable. Reading it as truthy instead
      // silently made every field that declares nothing nullable — including
      // `oauth_access_token.token`, which is also `unique`, and Postgres lets
      // any number of rows share a NULL under a unique index. Caught by
      // diffing against `auth generate`, which has always had this right.
      definition += onUpdateClause(field)
      if (field.required !== false) definition += ".notNull()"
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
const canonicalSchema = createAuthSchema(
  process.env.IDP_SCHEMA_NAME ?? CANONICAL_SCHEMA_NAME
)

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
  // The committed file is always canonical; `database.schema` retargets it at
  // runtime. `IDP_SCHEMA_NAME` is the one name for this — `drizzle.config.ts`
  // reads the same variable, where it used to be `IDP_DB_SCHEMA` here and the
  // two could disagree.
  const schemaName = CANONICAL_SCHEMA_NAME
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
