/**
 * Integration-test harness (TST-1).
 *
 * Each test file gets its **own uniquely named Postgres schema**, migrated from
 * the committed SQL. That is only cheap because the schema name is a runtime
 * value (DM-4): creating and dropping one schema is fast even on a shared
 * hosted database, so runs stay isolated without a per-file database.
 *
 * Connection: `IDP_TEST_DATABASE_URL`, else `DIRECT_DATABASE_URL`, else
 * `DATABASE_URL`. The direct endpoint is preferred because advisory locks do
 * not hold through a transaction pooler (S4) and several tests exercise them.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createAdminContext } from "@/server/admin/context"
import type { AdminContext } from "@/server/admin/context"
import { createAuth } from "@/server/auth/instance"
import { deriveConfig } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { clientSchema } from "@/server/config/schema/clients-schema"
import type { ClientEntry } from "@/server/config/schema/clients-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import type { RoleEntry } from "@/server/config/schema/roles-schema"
import { createDb, quoteIdentifier } from "@/server/db/client"
import type { DbHandle } from "@/server/db/client"
import { runMigrations } from "@/server/db/migrate"
import { createAudit } from "@/server/audit"
import { createCaptureMailer } from "@/server/email/mailer"
import { createLogger } from "@/server/logger"

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_FOLDER = join(HERE, "..", "..", "..", "drizzle")

/** Reads the repo-root `.env` so a developer needs no extra setup. */
function repoEnv(): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const text = readFileSync(
      join(HERE, "..", "..", "..", "..", "..", ".env"),
      "utf8"
    )
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (match)
        result[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, "")
    }
  } catch {
    /* none */
  }
  return result
}

export function testDatabaseUrl(): string {
  const env = { ...repoEnv(), ...process.env }
  const url =
    env.IDP_TEST_DATABASE_URL ?? env.DIRECT_DATABASE_URL ?? env.DATABASE_URL
  if (!url) {
    throw new Error(
      "No test database. Set IDP_TEST_DATABASE_URL, or DATABASE_URL in the repo-root .env. " +
        "Any Postgres will do; prefer a direct (non-pooled) endpoint, because several " +
        "tests assert session advisory locks and those do not hold through a transaction " +
        "pooler (S4, D27)."
    )
  }
  return url
}

export interface TestContextOptions {
  /** Overrides merged into the base `config.json`. */
  config?: Record<string, unknown>
  clients?: Record<string, unknown>[]
  roles?: RoleEntry[]
  /**
   * Stands in for the Have I Been Pwned range API (FR-AUTH-1).
   *
   * Supplied so the suite never reaches the internet: a test that depends on a
   * third party is a test that fails on a train. Without it the check fails
   * open, which is the documented production behaviour.
   */
  breachFetch?: (input: string, init?: RequestInit) => Promise<Response>
}

export interface TestContext {
  config: IdpConfig
  database: DbHandle
  auth: ReturnType<typeof createAuth>
  /** Filled in as the runtime would; `startup` stays unset unless a test sets it. */
  adminContext: AdminContext
  /** Capture transport: every e-mail the run would have sent (FR-MAIL-1). */
  mailer: ReturnType<typeof createCaptureMailer>
  schemaName: string
  /** Drops the schema and closes the pool. */
  teardown: () => Promise<void>
}

let schemaCounter = 0

/**
 * Builds a migrated database and a live Better Auth instance.
 *
 * `label` should be the test file's subject; it becomes part of the schema
 * name, so a failed run leaves an obviously-named schema behind to inspect.
 */
export async function createTestContext(
  label: string,
  options: TestContextOptions = {}
): Promise<TestContext> {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
  const schemaName = `idp_test_${slug}_${process.pid}_${++schemaCounter}`.slice(
    0,
    60
  )

  const file = configFileSchema.parse({
    server: { baseUrl: "http://localhost:3000" },
    secret: "integration-test-secret-0123456789abcdef",
    database: { url: testDatabaseUrl(), schema: schemaName },
    site: { name: "Test IdP" },
    jwt: { audience: "http://localhost:3000" },
    // A test file makes many attempts from one "IP"; the SEC-2 limits are real
    // and would throttle it. The rate limiter has its own suite, which turns
    // this back on and asserts the 429s.
    rateLimit: { enabled: false },
    ...options.config,
  })

  const clients: ClientEntry[] = (options.clients ?? []).map((client) =>
    clientSchema.parse(client)
  )
  const config = deriveConfig(file, clients, options.roles ?? BUILT_IN_ROLES)

  const database = createDb(config, { max: 4 })
  await database.sql.unsafe(
    `drop schema if exists ${quoteIdentifier(schemaName)} cascade`
  )
  await runMigrations(database, {
    migrationsFolder: MIGRATIONS_FOLDER,
    unlocked: true,
  })

  const logger = createLogger({ level: "error", write: () => {} })
  const mailer = createCaptureMailer(config, logger)
  const audit = createAudit(database, logger)
  // The admin context the runtime fills in after start-up. Tests get one too,
  // because `/idp/system` and `/idp/rotate-keys` answer 503 without it — and a
  // suite that could not reach them would be a suite that never notices they
  // stopped working.
  const adminContext = createAdminContext()
  const auth = createAuth({
    config,
    database,
    logger,
    mailer,
    audit,
    adminContext,
    ...(options.breachFetch ? { breachFetch: options.breachFetch } : {}),
  })
  adminContext.auth = auth

  // Better Auth starts its plugin `init()` as soon as the instance exists, and
  // the OAuth provider seeds `oauth_resource` there. Awaiting it means the
  // schema is still around when that query runs — the same reason the runtime
  // migrates before constructing the instance at all.
  await auth.$context

  return {
    config,
    database,
    auth,
    adminContext,
    mailer,
    schemaName,
    teardown: async () => {
      await database.sql.unsafe(
        `drop schema if exists ${quoteIdentifier(schemaName)} cascade`
      )
      await database.close()
    },
  }
}

/** A `Request` aimed at a Better Auth endpoint under the test issuer. */
export function authRequest(
  path: string,
  init: RequestInit & { json?: unknown } = {}
): Request {
  const { json, ...rest } = init
  const headers = new Headers(rest.headers)
  if (json !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  if (!headers.has("origin")) headers.set("origin", "http://localhost:3000")
  return new Request(`http://localhost:3000/api/auth${path}`, {
    ...rest,
    headers,
    ...(json !== undefined
      ? { body: JSON.stringify(json), method: rest.method ?? "POST" }
      : {}),
  })
}

/**
 * Reads the session cookie out of a response so a follow-up request can send
 * it.
 *
 * **The last live one**, not the first match. Some responses clear the current
 * session before setting a new one — impersonation does exactly that — so the
 * first `session_token` header can be the `Max-Age=0` deletion, and a test
 * that grabs it sends an empty token and is told it is not signed in. That
 * cost an hour of looking at the wrong end of `/admin/impersonate-user`.
 */
export function sessionCookie(response: Response): string | undefined {
  let found: string | undefined
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";")
    if (pair === undefined || !pair.includes("session_token")) continue
    // A deletion: `name=` with nothing after it, and `Max-Age=0` to say so.
    if (/=\s*$/.test(pair)) continue
    found = pair
  }
  return found
}
