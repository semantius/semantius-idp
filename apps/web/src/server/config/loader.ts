/**
 * Loads the config folder once, at startup (CFG-1..6).
 *
 * Order of operations, and why:
 *  1. read + parse JSONC, strip `$schema`            — CFG-1
 *  2. expand placeholders                            — CFG-2, before validation
 *  3. apply the three fallback environment variables — CFG-3, only for absent keys
 *  4. zod validation of all three files              — CFG-4/5, one pass
 *  5. cross-checks and warnings                      — CFG-5
 *  6. derive the effective configuration             — derive.ts
 *
 * Steps 4 and 5 never short-circuit: every problem is collected and thrown
 * together as one {@link ConfigError}.
 */

import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

import { deriveConfig } from "./derive"
import type { IdpConfig } from "./derive"
import { ConfigError } from "./errors"
import type { ConfigFileName, ConfigIssue, ConfigWarning } from "./errors"
import { parseJsoncText, stripSchemaKey } from "./jsonc"
import { substitutePlaceholders } from "./placeholders"
import { clientsFileSchema } from "./schema/clients-schema"
import type { ClientEntry } from "./schema/clients-schema"
import { configFileSchema } from "./schema/config-schema"
import { BUILT_IN_ROLES, rolesFileSchema } from "./schema/roles-schema"
import type { RoleEntry } from "./schema/roles-schema"
import { runCrossChecks } from "./cross-checks"
import { zodPathToPointer } from "./zod-helpers"

export const DEFAULT_CONFIG_DIR = "/config"

export interface LoadConfigOptions {
  /** Config folder. Defaults to `IDP_CONFIG_DIR`, then `/config` (CFG-1). */
  dir?: string
  /** Environment. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** File reader, injected in tests. Throws when the file does not exist. */
  readFile?: (path: string) => string
}

export interface LoadedConfig {
  config: IdpConfig
  warnings: ConfigWarning[]
  /** Absolute path of the folder the configuration was read from. */
  dir: string
}

/** Loads, validates and derives the configuration, or throws {@link ConfigError}. */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env: Record<string, string | undefined> = options.env ?? process.env
  const dir = options.dir ?? env.IDP_CONFIG_DIR ?? DEFAULT_CONFIG_DIR
  const readFile =
    options.readFile ?? ((path: string) => readFileSync(path, "utf8"))

  const issues: ConfigIssue[] = []

  // -- 1/2: read, parse, expand -------------------------------------------
  const configRaw = readAndExpand("config.json", join(dir, "config.json"), {
    required: true,
  })
  const clientsRaw = readAndExpand(
    "oauth_clients.json",
    join(dir, "oauth_clients.json"),
    { required: false }
  )
  const rolesRaw = readAndExpand("roles.json", join(dir, "roles.json"), {
    required: false,
  })

  function readAndExpand(
    file: ConfigFileName,
    path: string,
    { required }: { required: boolean }
  ): { value: unknown; placeholders: ReadonlySet<string> } | undefined {
    let text: string
    try {
      text = readFile(path)
    } catch {
      if (required) {
        issues.push({
          file,
          pointer: "",
          message: `Required file not found at ${path}.`,
          hint: "Mount the config folder read-only at /config, or point IDP_CONFIG_DIR at it.",
        })
      }
      return undefined
    }

    const parsed = parseJsoncText(file, text)
    issues.push(...parsed.issues)
    if (parsed.value === undefined) return undefined

    const substituted = substitutePlaceholders(
      file,
      stripSchemaKey(parsed.value),
      {
        env,
        readFile,
        isAbsolutePath: (candidate) => isAbsolute(candidate),
      }
    )
    issues.push(...substituted.issues)
    return {
      value: substituted.value,
      placeholders: substituted.placeholderPointers,
    }
  }

  // -- 3: fallback environment variables (CFG-3) ---------------------------
  const configInput = applyEnvFallbacks(configRaw?.value, env)

  // -- 4: schema validation ------------------------------------------------
  const configResult = configRaw
    ? configFileSchema.safeParse(configInput)
    : undefined
  if (configResult && !configResult.success) {
    issues.push(...toIssues("config.json", configResult.error.issues))
  }

  const clientsResult = clientsRaw
    ? clientsFileSchema.safeParse(clientsRaw.value)
    : undefined
  if (clientsResult && !clientsResult.success) {
    issues.push(...toIssues("oauth_clients.json", clientsResult.error.issues))
  }

  const rolesResult = rolesRaw
    ? rolesFileSchema.safeParse(rolesRaw.value)
    : undefined
  if (rolesResult && !rolesResult.success) {
    issues.push(...toIssues("roles.json", rolesResult.error.issues))
  }

  // A file that failed to parse or validate cannot take part in the
  // cross-checks; report what we have and stop.
  if (!configResult?.success || issues.length > 0) {
    if (!configResult?.success && issues.length === 0) {
      issues.push({
        file: "config.json",
        pointer: "",
        message: "Configuration could not be loaded.",
      })
    }
    throw new ConfigError(issues)
  }

  const clients: ClientEntry[] = clientsResult?.success
    ? clientsResult.data.clients
    : []
  const roles: RoleEntry[] = rolesResult?.success
    ? rolesResult.data.roles
    : BUILT_IN_ROLES

  // -- 5: cross-checks -----------------------------------------------------
  const { issues: crossIssues, warnings } = runCrossChecks({
    config: configResult.data,
    clients,
    roles,
    placeholderPointers: {
      config: configRaw?.placeholders ?? new Set<string>(),
      clients: clientsRaw?.placeholders ?? new Set<string>(),
    },
  })
  if (crossIssues.length > 0) throw new ConfigError(crossIssues)

  // -- 6: derive -----------------------------------------------------------
  return {
    config: deriveConfig(configResult.data, clients, roles),
    warnings,
    dir,
  }
}

/**
 * CFG-3 precedence: a fallback environment variable is consulted **only** when
 * the key is absent from the file. It never overrides a configured value.
 */
function applyEnvFallbacks(
  input: unknown,
  env: Record<string, string | undefined>
): unknown {
  if (input === undefined) return input
  const root = { ...(input as Record<string, unknown>) }
  const server = { ...(root.server as Record<string, unknown> | undefined) }
  const database = { ...(root.database as Record<string, unknown> | undefined) }
  const logging = { ...(root.logging as Record<string, unknown> | undefined) }

  if (server.baseUrl === undefined && env.BETTER_AUTH_URL)
    server.baseUrl = env.BETTER_AUTH_URL
  if (server.host === undefined && env.HOST) server.host = env.HOST
  if (server.port === undefined && env.PORT) server.port = env.PORT
  if (root.secret === undefined && env.BETTER_AUTH_SECRET)
    root.secret = env.BETTER_AUTH_SECRET
  if (database.url === undefined && env.DATABASE_URL)
    database.url = env.DATABASE_URL
  if (database.migrateOnBoot === undefined && env.IDP_MIGRATE_ON_BOOT) {
    database.migrateOnBoot = env.IDP_MIGRATE_ON_BOOT
  }
  if (logging.level === undefined && env.LOG_LEVEL)
    logging.level = env.LOG_LEVEL
  if (logging.format === undefined && env.LOG_FORMAT)
    logging.format = env.LOG_FORMAT

  root.server = server
  root.database = database
  root.logging = logging
  return root
}

interface ZodLikeIssue {
  path: readonly PropertyKey[]
  message: string
  code?: string
  keys?: readonly string[]
}

function toIssues(
  file: ConfigFileName,
  zodIssues: readonly ZodLikeIssue[]
): ConfigIssue[] {
  return zodIssues.map((issue) => {
    if (issue.code === "unrecognized_keys" && issue.keys?.length) {
      return {
        file,
        pointer: zodPathToPointer(issue.path),
        message: `Unknown ${issue.keys.length === 1 ? "key" : "keys"}: ${issue.keys.map((key) => `\`${key}\``).join(", ")}.`,
        hint: "Unknown keys are rejected so a typo cannot silently disable a setting.",
      } satisfies ConfigIssue
    }
    return {
      file,
      pointer: zodPathToPointer(issue.path),
      message: issue.message,
    } satisfies ConfigIssue
  })
}
