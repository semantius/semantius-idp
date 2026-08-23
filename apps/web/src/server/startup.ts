/**
 * Startup sequence (OPS-2).
 *
 * ```
 * load + validate config → connect DB → migrate → ensure signing key
 *   → reconcile clients/resources → validate roles against the DB
 *   → bootstrap admin → listen → ready
 * ```
 *
 * Two rules hold throughout:
 *
 * - **Every shared-state step runs under a Postgres advisory lock** on the
 *   *direct* connection (`database.directUrl`), because a session lock does not
 *   hold through a transaction pooler — see `docs/spikes/s4-schema-placement.md`.
 *   Single-instance is the supported topology (OPS-11), but two containers
 *   restarting together is ordinary, and neither may half-apply anything.
 *
 * - **Any failure exits non-zero with one actionable error.** Not a stack
 *   trace, not three cascading errors: the operator gets the sentence that says
 *   what to change.
 */

import { createLocalAccountIssuer } from "@better-auth/core/db"

import { createAudit  } from "./audit"
import type {Audit} from "./audit";
import type { IdpConfig } from "./config/derive"
import { ConfigError } from "./config/errors"
import type { DbHandle } from "./db/client"
import { withAdvisoryLock } from "./db/advisory-lock"
import { migrationsAreCurrent, runMigrations } from "./db/migrate"
import type { Logger } from "./logger"
import type { Auth } from "./auth/instance"

export interface StartupDeps {
  config: IdpConfig
  /** The request-serving handle (pooled). */
  database: DbHandle
  /** Direct, non-pooled handle used for every advisory-locked step. */
  locking: DbHandle
  auth: Auth
  logger: Logger
}

export interface StartupResult {
  /** Steps that ran, in order, for the log and the admin system page. */
  steps: { name: string; skipped?: string }[]
}

export type StartupStep = StartupResult["steps"][number]

/**
 * The part of the sequence that must happen **before the Better Auth instance
 * is constructed**.
 *
 * The OAuth provider plugin seeds `oauth_resource` from its own `init()`, which
 * runs as soon as the instance is built. On a fresh database that is a query
 * against a table that does not exist yet, and the process dies before it can
 * migrate. So migrations come first, on the direct connection, under the lock —
 * which is the order OPS-2 states anyway.
 */
export async function runMigrationPhase(deps: {
  config: IdpConfig
  database: DbHandle
  locking: DbHandle
  logger: Logger
}): Promise<StartupStep> {
  if (deps.config.file.database.migrateOnBoot) {
    await runMigrations(deps.locking, { logger: deps.logger })
    return { name: "migrate" }
  }

  if (!(await migrationsAreCurrent(deps.database))) {
    throw new StartupError(
      "The database is not migrated and `database.migrateOnBoot` is false. " +
        "Run `idp migrate` against this database, or set `database.migrateOnBoot: true`."
    )
  }
  return { name: "migrate", skipped: "database.migrateOnBoot is false" }
}

/** Better Auth's provider id for an e-mail + password credential. */
const CREDENTIAL_PROVIDER_ID = "credential"

/** Thrown with the single actionable message an operator should act on. */
export class StartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "StartupError"
  }
}

/**
 * The rest of the sequence, run once the auth instance exists:
 * signing key → reconcile clients/resources → validate roles → bootstrap admin.
 */
export async function runStartup(
  deps: StartupDeps,
  earlier: StartupStep[] = []
): Promise<StartupResult> {
  const { config, logger, locking } = deps
  const steps: StartupResult["steps"] = [...earlier]
  const audit = createAudit(deps.database, logger)

  // -- signing key (FR-OIDC-16, risk R11) ----------------------------------
  await step(steps, "signing key", async () => {
    await ensureSigningKey(deps, locking)
  })

  // -- clients and resources (FR-OIDC-2) -----------------------------------
  // Reconciliation lands in M8; the step is listed so the sequence and its
  // locking are in place, and so `/admin/system` can report it.
  steps.push({
    name: "reconcile clients",
    skipped: config.clients.length === 0 ? "no clients configured" : undefined,
  })

  // -- roles vs. the database (FR-ROLE-2) ----------------------------------
  await step(steps, "validate roles", async () => {
    await warnAboutUnknownRoles(deps)
  })

  // -- bootstrap admin (FR-ADMIN-1) ----------------------------------------
  await step(steps, "bootstrap admin", async () => {
    await bootstrapAdmin(deps, locking, audit)
  })

  logger.info("startup complete", {
    steps: steps.map((entry) =>
      entry.skipped ? `${entry.name} (skipped)` : entry.name
    ),
    issuer: config.base.origin + config.base.basePath,
  })
  return { steps }
}

async function step(
  steps: StartupResult["steps"],
  name: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run()
    steps.push({ name })
  } catch (error) {
    if (error instanceof StartupError || error instanceof ConfigError)
      throw error
    throw new StartupError(
      `Startup failed during "${name}": ${describe(error)}`,
      { cause: error }
    )
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Ensures a signing key exists before anything can need one (FR-OIDC-16).
 *
 * Generating it lazily on the first token request would mean two concurrent
 * requests could each generate one, and the first client to fetch the JWKS
 * might see a key that is not yet the signing key (risk R11). Creating it here,
 * under a lock, means a key is always *published before it signs*.
 */
async function ensureSigningKey(
  deps: StartupDeps,
  locking: DbHandle
): Promise<void> {
  await withAdvisoryLock(locking.sql, "signingKey", async () => {
    const existing = await locking.db
      .select({ id: locking.schema.jwks.id })
      .from(locking.schema.jwks)
      .limit(1)
    if (existing.length > 0) return

    // The JWKS endpoint is the supported way to materialise the first key pair:
    // it generates it, encrypts the private half with `secret`, stores it and
    // publishes it — all before anything can ask for a signature.
    const response = await deps.auth.handler(
      new Request(
        `${deps.config.base.origin}${deps.config.base.basePath}/api/auth/jwks`
      )
    )
    if (!response.ok) {
      throw new StartupError(
        `Could not generate the signing key (JWKS endpoint returned ${response.status}). ` +
          "Check that `secret` is set and the database is writable."
      )
    }

    deps.logger.info("signing key generated", {
      algorithm: deps.config.file.jwt.algorithm,
    })
  })
}

/**
 * FR-ROLE-2: a role that is stored on a user but no longer in `roles.json` is
 * dropped from their claims. That is a silent behaviour change for whoever
 * holds it, so it is warned about at boot and flagged in the admin UI.
 */
async function warnAboutUnknownRoles(deps: StartupDeps): Promise<void> {
  const catalog = new Set(deps.config.roles.map((role) => role.name))
  const rows = await deps.database.db
    .select({ role: deps.database.schema.user.role })
    .from(deps.database.schema.user)

  const unknown = new Map<string, number>()
  for (const row of rows) {
    for (const name of splitRoles(row.role)) {
      if (catalog.has(name)) continue
      unknown.set(name, (unknown.get(name) ?? 0) + 1)
    }
  }

  for (const [name, count] of unknown) {
    deps.logger.warn(
      "stored role is not in the catalog and will be dropped from claims",
      {
        role: name,
        users: count,
        hint: "Add it to roles.json, or reassign those users in /admin/users.",
      }
    )
  }
}

/** `user.role` holds several roles comma-separated (FR-ROLE-2). */
export function splitRoles(value: string | null | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "")
}

/**
 * Bootstrap admin (FR-ADMIN-1).
 *
 * Created **iff no user holds an admin role** — not "if the table is empty",
 * so an operator who deletes the bootstrap account and keeps another admin does
 * not get it back. Idempotent under the lock, so two boots create exactly one.
 * The password is never logged. Automatic promotion of the first sign-up is
 * deliberately not implemented.
 */
async function bootstrapAdmin(
  deps: StartupDeps,
  locking: DbHandle,
  audit: Audit
): Promise<void> {
  const bootstrap = deps.config.file.admin.bootstrap
  const email = bootstrap?.email.trim().toLowerCase() ?? ""
  const password = bootstrap?.password ?? ""

  if (email === "" || password === "") {
    // The config loader already warned; nothing more to do.
    return
  }

  await withAdvisoryLock(locking.sql, "bootstrapAdmin", async () => {
    if (await hasAnyAdmin(deps, locking)) {
      deps.logger.info("bootstrap admin skipped: an admin already exists")
      return
    }

    const context = await deps.auth.$context
    const existing = await context.internalAdapter.findUserByEmail(email)
    if (existing) {
      // The address is taken by a non-admin. Promoting silently would be a
      // privilege escalation nobody asked for.
      throw new StartupError(
        `Cannot create the bootstrap admin: ${email} already exists but holds no admin role. ` +
          "Grant them an admin role in /admin/users, or point `admin.bootstrap.email` at a new address."
      )
    }

    const adminRole = deps.config.adminRoles[0] ?? "admin"
    const created = await context.internalAdapter.createUser(
      {
        email,
        name: bootstrap?.name ?? "Administrator",
        emailVerified: true,
        role: adminRole,
        status: "active",
        approvedAt: new Date(),
        approvedBy: "system",
        // FR-ADMIN-1: the first sign-in must change it.
        mustChangePassword: true,
      },
      // The provisioning source drives `user.validateUserInfo`; this account
      // comes from the operator's configuration, not from anyone signing up.
      { method: "admin" }
    )

    await context.internalAdapter.createAccount({
      userId: created.id,
      providerId: CREDENTIAL_PROVIDER_ID,
      // Better Auth namespaces local credentials so a provider id can never
      // collide with an OAuth identity.
      issuer: createLocalAccountIssuer(CREDENTIAL_PROVIDER_ID),
      accountId: created.id,
      // SEC-10: the same hashing the sign-in path verifies with.
      password: await context.password.hash(password),
    })

    deps.logger.warn("bootstrap admin created", {
      email,
      role: adminRole,
      hint: "Sign in and change the password; the environment variables can then be unset.",
    })
    await audit.record({
      action: "signup.created",
      outcome: "success",
      actorType: "system",
      target: { type: "user", id: created.id },
      metadata: { bootstrap: true, role: adminRole },
    })
  })
}

async function hasAnyAdmin(
  deps: StartupDeps,
  locking: DbHandle
): Promise<boolean> {
  const rows = await locking.db
    .select({ role: locking.schema.user.role })
    .from(locking.schema.user)
  const adminRoles = new Set(deps.config.adminRoles)
  return rows.some((row) =>
    splitRoles(row.role).some((role) => adminRoles.has(role))
  )
}
