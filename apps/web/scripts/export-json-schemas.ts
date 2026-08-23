/**
 * Generates the JSON Schemas that ship in `config.example/` (CFG-1, CFG-5).
 *
 * The zod schemas are the single source of truth; these files exist so editors
 * can offer completion and inline validation through the `$schema` key. CI runs
 * this with `--check` and fails when the committed output is stale, so the two
 * can never drift.
 *
 *   bun run scripts/export-json-schemas.ts [--check]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { z } from "zod"

import { clientsFileSchema } from "../src/server/config/schema/clients-schema"
import { configFileSchema } from "../src/server/config/schema/config-schema"
import { rolesFileSchema } from "../src/server/config/schema/roles-schema"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, "..", "..", "..", "config.example")

const TARGETS = [
  {
    file: "config.schema.json",
    title: "semantius-idp config.json",
    schema: configFileSchema,
  },
  {
    file: "oauth_clients.schema.json",
    title: "semantius-idp oauth_clients.json",
    schema: clientsFileSchema,
  },
  {
    file: "roles.schema.json",
    title: "semantius-idp roles.json",
    schema: rolesFileSchema,
  },
] as const

function render(title: string, schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, {
    // The authoring view: string escape hatches for placeholder substitution
    // are an implementation detail and stay out of the editor experience.
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>
  return `${JSON.stringify({ ...json, title }, null, 2)}\n`
}

function main(): void {
  const check = process.argv.includes("--check")
  mkdirSync(OUT_DIR, { recursive: true })

  const stale: string[] = []
  for (const target of TARGETS) {
    const path = join(OUT_DIR, target.file)
    const next = render(target.title, target.schema)
    if (check) {
      let current = ""
      try {
        current = readFileSync(path, "utf8")
      } catch {
        current = ""
      }
      if (current !== next) stale.push(target.file)
      continue
    }
    writeFileSync(path, next, "utf8")
    process.stdout.write(`wrote config.example/${target.file}\n`)
  }

  if (stale.length > 0) {
    process.stderr.write(
      `Config JSON Schemas are stale: ${stale.join(", ")}\n` +
        "Run `pnpm --filter web run config:schemas` and commit the result.\n"
    )
    process.exit(1)
  }
}

main()
