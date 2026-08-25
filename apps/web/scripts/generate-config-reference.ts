/**
 * Generates `docs/configuration.md` from the zod schemas (CFG-4, DOC-1).
 *
 * DOC-1 asks for a configuration reference **generated from the schemas**,
 * because a hand-written one is wrong the first time a default changes and
 * nobody can tell by reading it. The zod schemas are the single source of
 * truth for the loader, the JSON Schemas in `config.example/` and this table
 * alike; CI runs this with `--check` and fails when the committed output is
 * stale, exactly as it does for the schemas.
 *
 *   bun run scripts/generate-config-reference.ts [--check]
 *
 * Only `config.json` is rendered here. `oauth_clients.json` and `roles.json`
 * are documented where they are *used* — `docs/clients.md` (DOC-3) and the
 * roles section of the README — because a client entry is read as a whole and
 * a flat table of its twenty fields teaches nobody how to write one.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { z } from "zod"

import { configFileSchema } from "../src/server/config/schema/config-schema"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, "..", "..", "..", "docs", "configuration.md")

interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  default?: unknown
  description?: string
  additionalProperties?: JsonSchema | boolean
  format?: string
}

interface Row {
  key: string
  type: string
  required: boolean
  fallback: string
  description: string
}

/**
 * A readable type for one property.
 *
 * The schemas accept more shapes than they document on purpose — a duration
 * is a string *or* a number of seconds, a boolean may arrive as the string
 * `"true"` because it came through `${env:…}` — so the union is collapsed to
 * the shape an operator should actually write. Reporting `string | number |
 * boolean` for every second key would be accurate and useless.
 */
function typeOf(schema: JsonSchema): string {
  if (schema.enum) {
    return schema.enum.map((value) => `\`${String(value)}\``).join(" \\| ")
  }
  if (schema.const !== undefined) return `\`${String(schema.const)}\``

  const branches = schema.anyOf ?? schema.oneOf
  if (branches) {
    const named = branches
      .map((branch) => typeOf(branch))
      .filter((name) => name !== "")
    // `object | string` is the placeholder escape hatch; the object is the
    // shape being documented.
    const objects = named.filter((name) => name.startsWith("{"))
    const unique = [...new Set(objects.length > 0 ? objects : named)]
    return unique.join(" \\| ")
  }

  if (schema.type === "array") {
    return schema.items ? `${typeOf(schema.items)}[]` : "array"
  }
  if (schema.type === "object") return "{ … }"
  if (Array.isArray(schema.type)) return schema.type.join(" \\| ")
  return schema.type ?? ""
}

/**
 * The smallest `config.json` the schema accepts.
 *
 * Parsed once so the defaults in the table are the values the loader actually
 * produces, rather than whatever survived into the JSON Schema. Most of them
 * do not: a `flexInt` or a `duration` is a `z.preprocess` pipe, and
 * `z.toJSONSchema` renders the input side of a pipe without its default — so
 * reading the schema alone reported "no default" for two thirds of the keys,
 * which is worse than no reference at all.
 *
 * A new **required** key makes this throw, loudly, on the next run. That is
 * the intended failure: the reference cannot be generated without knowing what
 * a minimal file looks like, and neither can anyone reading it.
 */
const MINIMAL = {
  server: { baseUrl: "https://idp.example.com" },
  secret: "0123456789abcdef0123456789abcdef",
  database: { url: "postgres://idp@localhost:5432/idp" },
  site: { name: "Example" },
  jwt: { audience: "https://idp.example.com" },
}

/** The paths MINIMAL supplies, whose "defaults" are this script's invention. */
function suppliedPaths(): Set<string> {
  const paths = new Set<string>()
  const visit = (value: unknown, prefix: string): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      paths.add(prefix)
      return
    }
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, prefix === "" ? key : `${prefix}.${key}`)
    }
  }
  visit(MINIMAL, "")
  return paths
}

const SUPPLIED = suppliedPaths()

function defaultsFrom(): Record<string, unknown> {
  const parsed = configFileSchema.parse(MINIMAL) as Record<string, unknown>
  const flat: Record<string, unknown> = {}
  const visit = (value: unknown, prefix: string): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      flat[prefix] = value
      return
    }
    for (const [key, nested] of Object.entries(value)) {
      const path = prefix === "" ? key : `${prefix}.${key}`
      flat[path] = nested
      visit(nested, path)
    }
  }
  visit(parsed, "")
  // A value this script invented is not a default. Reporting
  // `https://idp.example.com` as the default issuer would be a lie that reads
  // like documentation.
  for (const path of suppliedPaths()) delete flat[path]
  return flat
}

function defaultOf(schema: JsonSchema, resolved: unknown): string {
  const value = schema.default ?? resolved
  if (value === undefined) return ""
  if (typeof value === "string") {
    return value === "" ? '`""`' : `\`${value}\``
  }
  if (typeof value === "object" && value !== null) {
    // Short enough to read in a cell, or a shape whose interesting parts have
    // rows of their own.
    const json = JSON.stringify(value)
    return json.length <= 64 ? `\`${json}\`` : "see below"
  }
  return `\`${JSON.stringify(value)}\``
}

/**
 * Every leaf, in declaration order, as `section.key`.
 *
 * Nested objects are flattened because that is how CFG-2's placeholders and
 * every error message name them (`database.directUrl`, not "directUrl, under
 * database"). A record whose *keys* the operator chooses — `jwt.claims`,
 * `social.<provider>` — is a leaf: its contents are not a fixed inventory.
 */
function walk(
  schema: JsonSchema,
  prefix: string,
  rows: Row[],
  resolved: Record<string, unknown>
): void {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])

  for (const [name, property] of Object.entries(properties)) {
    const key = prefix === "" ? name : `${prefix}.${name}`
    const nested = objectShape(property)

    if (nested && nested.properties) {
      walk(nested, key, rows, resolved)
      continue
    }

    rows.push({
      key,
      type: typeOf(property),
      // `MINIMAL` **is** the required set — it is the smallest file the schema
      // accepts, and it throws above if that stops being true. The JSON
      // Schema's own `required` is only consulted at the top level, because
      // `z.toJSONSchema` does not emit one for nested objects.
      required: SUPPLIED.has(key) || (required.has(name) && !nested),
      fallback: defaultOf(property, resolved[key]),
      description: (property.description ?? "").replace(/\s+/g, " ").trim(),
    })
  }
}

/** The object branch of a property, if it has one worth descending into. */
function objectShape(schema: JsonSchema): JsonSchema | undefined {
  if (schema.properties) return schema
  const branches = schema.anyOf ?? schema.oneOf ?? schema.allOf
  return branches?.find((branch) => branch.properties)
}

function render(rows: Row[]): string {
  const lines = [
    "<!-- Generated by apps/web/scripts/generate-config-reference.ts.",
    "     Edit the zod schemas in apps/web/src/server/config/schema/ instead;",
    "     CI fails when this file is stale. -->",
    "",
    "# Configuration reference",
    "",
    "Every key of `config.json`, generated from the schemas the loader itself",
    "validates against (CFG-4). A key marked **required** has no default and",
    "start-up fails without it.",
    "",
    "Values are JSONC — comments and trailing commas are allowed — and any",
    "string may contain `${env:NAME}`, `${env:NAME:-default}` or",
    "`${file:/abs/path}`, substituted once before validation (CFG-2). Three keys",
    "also have a fallback environment variable, used only when the file leaves",
    "them out: `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` and `DATABASE_URL`",
    "(CFG-3).",
    "",
    "Configuration is read **once**, at start-up. Changing it means restarting",
    "the process; there is no hot reload and `SIGHUP` is ignored (CFG-5).",
    "",
    "| Key | Type | Default | Notes |",
    "| --- | --- | --- | --- |",
  ]

  for (const row of rows) {
    const fallback = row.required ? "— **required**" : (row.fallback || "—")
    lines.push(
      `| \`${row.key}\` | ${row.type || "—"} | ${fallback} | ${row.description || ""} |`
    )
  }

  lines.push(
    "",
    "## Environment-only settings",
    "",
    "These never appear in a file. They decide where the configuration is read",
    "from and how the process behaves before any of it has been parsed (CFG-3).",
    "",
    "| Variable | Default | What it does |",
    "| --- | --- | --- |",
    "| `IDP_CONFIG_DIR` | `/config` | The folder holding `config.json` and its companions. |",
    "| `HOST` / `PORT` | `0.0.0.0` / `3000` | Where the process listens, when the file leaves `server.host`/`server.port` out. |",
    "| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | As `logging.level` / `logging.format`. |",
    "| `IDP_MIGRATE_ON_BOOT` | `true` | As `database.migrateOnBoot`. |",
    "| `IDP_EMAIL_TRANSPORT` | — | `capture` writes each message to disk instead of sending it (D30). For tests and development; never set it on a deployment that people rely on for password resets. |",
    "| `IDP_EMAIL_CAPTURE_DIR` | `/tmp/idp-mail` | Where that transport writes. |",
    ""
  )

  return lines.join("\n")
}

function main(): void {
  const json = z.toJSONSchema(configFileSchema, {
    io: "input",
    unrepresentable: "any",
  }) as JsonSchema

  const rows: Row[] = []
  walk(json, "", rows, defaultsFrom())

  const next = render(rows)
  if (process.argv.includes("--check")) {
    let current = ""
    try {
      current = readFileSync(OUT, "utf8")
    } catch {
      current = ""
    }
    if (current !== next) {
      process.stderr.write(
        "docs/configuration.md is stale.\n" +
          "Run `pnpm --filter web run docs:config` and commit the result.\n"
      )
      process.exit(1)
    }
    return
  }

  writeFileSync(OUT, next, "utf8")
  process.stdout.write(`wrote docs/configuration.md (${rows.length} keys)\n`)
}

main()
