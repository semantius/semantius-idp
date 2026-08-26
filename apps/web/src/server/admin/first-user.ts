/**
 * The first-run setup: who creates the very first account, and when (**D52**).
 *
 * Until this existed the first administrator came out of `IDP_ADMIN_EMAIL` and
 * `IDP_ADMIN_PASSWORD` — a password in an environment file, a forced change at
 * first sign-in, and a documented instruction to unset both variables
 * afterwards that nobody ever gets round to. That footgun is the recorded cause
 * of this deployment's one credentials incident, and `idp reset-admin` existed
 * only to recover from the account it stranded.
 *
 * Both are gone. **While the `user` table is empty the IdP asks for the first
 * user in a page** (`routes/setup.tsx`), and whoever completes it is signed in
 * as an administrator. No credential is ever written down, and there is nothing
 * to unset.
 *
 * Two invariants make that safe:
 *
 *  - **The gate is "the table is empty", not "no admin exists".** Once any user
 *    exists the page is gone for good, so it cannot be used to mint a second
 *    administrator on a running deployment — which is what a "no admin yet"
 *    gate would allow after somebody deleted the last one.
 *  - **The creation re-checks that under the `bootstrapAdmin` advisory lock, on
 *    the direct connection.** Two browsers submitting the form at the same
 *    moment is the ordinary race, not an exotic one; the loser is told the
 *    deployment is already set up rather than getting a second account.
 *
 * Lockout recovery is no longer a command. It is: another administrator, the
 * password-reset e-mail, or — last resort, in `docs/runbooks.md` — one SQL
 * statement promoting an existing user. That trade is recorded in D52.
 */

import { createLocalAccountIssuer } from "@better-auth/core/db"

import type { Audit } from "../audit"
import type { Auth } from "../auth/instance"
import { createUserWithoutRequest } from "../auth/provisioning"
import type { IdpConfig } from "../config/derive"
import { withAdvisoryLock } from "../db/advisory-lock"
import type { DbHandle } from "../db/client"
import { displayName } from "../display-name"
import type { Logger } from "../logger"

/** Better Auth's provider id for an e-mail + password credential. */
const CREDENTIAL_PROVIDER_ID = "credential"

export interface FirstUserDeps {
  config: IdpConfig
  /** Request-serving handle; the audit row and the read both use it. */
  database: DbHandle
  /** Direct, non-pooled handle — the advisory lock lives on this one (D27). */
  locking: DbHandle
  auth: Auth
  audit: Audit
  logger: Logger
}

export interface FirstUserInput {
  email: string
  firstName: string
  lastName: string
  password: string
}

export interface FirstUserResult {
  /** False when another submission won the race; the caller says "already set up". */
  created: boolean
  userId?: string
  role?: string
}

/**
 * Whether the deployment still has no users, memoised for the life of the
 * process.
 *
 * **Memoised in one direction only.** `true` is re-checked on every ask, because
 * it is about to become false and a stale `true` would show the setup page to
 * somebody who should see the login form. `false` is never re-queried: a
 * deployment cannot go back to having no users while it is running (deleting
 * the last user is refused by the last-admin invariant), and this is read on
 * `/` and `/login`, which are the two busiest pages there are. OPS-11's
 * single-instance topology is what makes the cached answer correct.
 */
let pending: boolean | undefined

export async function isSetupPending(database: DbHandle): Promise<boolean> {
  if (pending === false) return false

  const rows = await database.db
    .select({ id: database.schema.user.id })
    .from(database.schema.user)
    .limit(1)

  pending = rows.length === 0
  return pending
}

/** Closes the gate for good. Called by the POST that creates the first user. */
export function markSetupComplete(): void {
  pending = false
}

/**
 * Forgets the memoised answer.
 *
 * For tests only: each integration file runs against its own throwaway schema
 * inside one process, so a `false` cached by one would otherwise decide the
 * gate for the next.
 */
export function resetSetupGate(): void {
  pending = undefined
}

/**
 * Creates the first user as an administrator, or reports that somebody else
 * already did.
 *
 * The account is `active`, e-mail-verified and carries **no** forced password
 * change: the person typing the password is the person who will use it, which
 * is the entire difference between this and the bootstrap it replaces.
 */
export async function createFirstUser(
  deps: FirstUserDeps,
  input: FirstUserInput
): Promise<FirstUserResult> {
  const email = input.email.trim().toLowerCase()
  const role = deps.config.adminRoles[0] ?? "admin"

  const result = await withAdvisoryLock(
    deps.locking.sql,
    "bootstrapAdmin",
    async (): Promise<FirstUserResult> => {
      // The re-check that makes the lock worth taking: the loser of a
      // concurrent POST finds the table no longer empty and creates nothing.
      const existing = await deps.locking.db
        .select({ id: deps.locking.schema.user.id })
        .from(deps.locking.schema.user)
        .limit(1)
      if (existing.length > 0) return { created: false }

      const context = await deps.auth.$context

      const created = await createUserWithoutRequest(
        context,
        {
          email,
          // D49: derived, never typed. The database hook composes the same
          // fallback, but it does not know `site.nameFormat`.
          name:
            displayName(
              input.firstName,
              input.lastName,
              deps.config.file.site.nameFormat
            ) || email,
          ...(input.firstName ? { firstName: input.firstName } : {}),
          ...(input.lastName ? { lastName: input.lastName } : {}),
          emailVerified: true,
          role,
          status: "active",
          approvedAt: new Date(),
          approvedBy: "system",
          // Not the bootstrap account: nobody handed this password over, so
          // there is nothing to change at the first sign-in (D52).
          mustChangePassword: false,
        },
        // Drives `user.validateUserInfo`; the social rules are scoped to
        // `method: "oauth"` and do not apply here.
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
        password: await context.password.hash(input.password),
      })

      return { created: true, userId: created.id, role }
    }
  )

  // `withAdvisoryLock` only returns `undefined` with `skipIfLocked`, which this
  // call does not pass — the branch is here so a future change cannot turn a
  // missing result into a silent success.
  if (!result) return { created: false }

  if (result.created) {
    markSetupComplete()
    deps.logger.info("first user created through the setup page", {
      email,
      role,
    })
    // `user.created`, not `signup.created` (**D66**): this is not a
    // self-service registration, it is the act of configuring the deployment,
    // and `via: "setup"` says which of the two ways an account can be made
    // for somebody. Written here because nothing else can see it — the
    // wizard does not go through `/admin/create-user`, and the caller is by
    // definition not an administrator yet.
    await deps.audit.record({
      action: "user.created",
      outcome: "success",
      actorType: "anonymous",
      target: { type: "user", id: result.userId! },
      metadata: { via: "setup", role },
    })
  }

  return result
}
