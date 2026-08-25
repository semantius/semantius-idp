/**
 * `idp reset-admin` — the way back in (OPS-6, FR-ADMIN-1).
 *
 * The bootstrap admin's password exists in exactly two places: the `.env` that
 * created it, and the operator's head after the forced first change. Lose the
 * second and the account is *stranded* — it signed in once, the password is
 * unknown, and `mustChangePassword` is still set, so even a remembered guess
 * would land on the change page rather than anywhere useful. Until this
 * command existed the only documented recovery was `drop schema idp cascade`,
 * which is a data-loss operation offered as a password reset.
 *
 * This is the durable fix the plan promised under the name `create-admin`. It
 * is called `reset-admin` because resetting is what it is for, and creating is
 * the degenerate case: run with no argument against a database that has no
 * such account, it provisions `admin.bootstrap.email` on exactly the terms
 * start-up would have. An address typed on the command line is only ever
 * *reset* — see `mayCreate` below for why.
 *
 * **What it does not do is promote.** If the address exists and holds no admin
 * role, the command refuses. Otherwise a local command with database access
 * would be a one-line privilege escalation for any account in the deployment,
 * and the whole point of the bootstrap rules (`startup.ts`) is that nothing
 * grants an admin role implicitly.
 *
 * **What it resets**, all under the `bootstrapAdmin` advisory lock so it cannot
 * race a container that is booting:
 *
 *  - the credential password, back to `admin.bootstrap.password` — the same
 *    value the first boot used, so an operator who still has the `.env` needs
 *    to look nothing up;
 *  - `mustChangePassword`, back to `true`, so the next sign-in is forced
 *    through the change page again (FR-ADMIN-1) and the shared value in the
 *    `.env` never becomes the standing password;
 *  - the account's reachability — `status: active`, unbanned, verified —
 *    because an admin who banned themselves is locked out the same way;
 *  - every session, deleted. A reset that left the previous holder signed in
 *    would not be one.
 *
 * The password is read from configuration and never printed, never logged and
 * never written to the audit trail.
 */

import { createLocalAccountIssuer } from "@better-auth/core/db"
import { and, eq } from "drizzle-orm"

import type { Audit } from "../audit"
import type { IdpConfig } from "../config/derive"
import { withAdvisoryLock } from "../db/advisory-lock"
import type { DbHandle } from "../db/client"
import type { Logger } from "../logger"
import type { Auth } from "../auth/instance"
import { createUserWithoutRequest } from "../auth/provisioning"
import { isAdmin } from "../role-utils"

/** Better Auth's provider id for an e-mail + password credential. */
const CREDENTIAL_PROVIDER_ID = "credential"

/** Raised with the one sentence the operator should act on. */
export class ResetAdminError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResetAdminError"
  }
}

export interface ResetAdminDeps {
  config: IdpConfig
  /** The pooled handle: reads, and the two direct table writes. */
  database: DbHandle
  /** Direct, non-pooled: the advisory lock lives on this one (D27). */
  locking: DbHandle
  auth: Auth
  logger: Logger
  audit?: Audit
}

export interface ResetAdminResult {
  email: string
  /** The account did not exist and was provisioned. */
  created: boolean
  role: string
  /** How many live sessions the reset ended. */
  sessionsRevoked: number
  /** The account was banned, rejected or pending, and is now active. */
  reactivated: boolean
}

/**
 * Resolves which account to act on.
 *
 * An explicit address is the operator's; otherwise it is whichever address
 * `admin.bootstrap.email` names, which is the one this command exists for.
 */
function resolveEmail(config: IdpConfig, requested?: string): string {
  const email = (requested ?? config.file.admin.bootstrap?.email ?? "")
    .trim()
    .toLowerCase()
  if (email !== "") return email
  throw new ResetAdminError(
    "No address to reset: pass one (`idp reset-admin you@example.com`) or set " +
      "`admin.bootstrap.email` (IDP_ADMIN_EMAIL) in the configuration."
  )
}

/**
 * The password every reset lands on.
 *
 * Deliberately the *configured* one rather than a generated one: a generated
 * password would have to be printed, and a password on a terminal is a
 * password in a scrollback buffer and a shell history. This value is already
 * in the operator's `.env`, so the command reveals nothing they do not have —
 * and `mustChangePassword` guarantees it survives exactly one sign-in.
 */
function resolvePassword(config: IdpConfig): string {
  const password = config.file.admin.bootstrap?.password ?? ""
  if (password !== "") return password
  throw new ResetAdminError(
    "`admin.bootstrap.password` (IDP_ADMIN_PASSWORD) is not set, and this command " +
      "resets to that value. Set it to the password you want to sign in with once, " +
      "then run this again; the next sign-in is forced to change it."
  )
}

/** The columns this command reasons about, which the base user type lacks. */
async function loadUserRow(
  database: DbHandle,
  id: string
): Promise<
  | {
      id: string
      role: string | null
      status: "pending" | "active" | "rejected"
      banned: boolean | null
    }
  | undefined
> {
  const { user } = database.schema
  const [row] = await database.db
    .select({
      id: user.id,
      role: user.role,
      status: user.status,
      banned: user.banned,
    })
    .from(user)
    .where(eq(user.id, id))
    .limit(1)
  return row
}

export async function resetAdmin(
  deps: ResetAdminDeps,
  options: { email?: string } = {}
): Promise<ResetAdminResult> {
  const email = resolveEmail(deps.config, options.email)
  // **Only the configured address may be created.** Creating is the bootstrap
  // contract — `admin.bootstrap.email` names the account this deployment is
  // supposed to have — and running it against a fresh database is the intended
  // path. A *typed* address is different: with create-if-missing, one typo in
  // `idp reset-admin adnim@example.com` quietly provisions a second
  // administrator instead of failing, which is the wrong direction for a
  // mistake to go. To add an administrator at a new address, point
  // `admin.bootstrap.email` at it, or use /admin/users.
  const mayCreate = options.email === undefined
  const password = resolvePassword(deps.config)
  const adminRoles = deps.config.adminRoles
  const context = await deps.auth.$context

  const result = await withAdvisoryLock(
    deps.locking.sql,
    "bootstrapAdmin",
    async (): Promise<ResetAdminResult> => {
      const existing = await context.internalAdapter.findUserByEmail(email)

      if (!existing) {
        if (!mayCreate) {
          throw new ResetAdminError(
            `${email} has no account here, and an explicitly named address is never created — ` +
              "a typo would provision a second administrator instead of failing. " +
              "Point `admin.bootstrap.email` (IDP_ADMIN_EMAIL) at it and run this with no argument."
          )
        }
        const role = adminRoles[0] ?? "admin"
        const created = await createUserWithoutRequest(
          context,
          {
            email,
            name: deps.config.file.admin.bootstrap?.name ?? "Administrator",
            emailVerified: true,
            role,
            status: "active",
            approvedAt: new Date(),
            approvedBy: "system",
            mustChangePassword: true,
          },
          { method: "admin" }
        )
        await context.internalAdapter.createAccount({
          userId: created.id,
          providerId: CREDENTIAL_PROVIDER_ID,
          issuer: createLocalAccountIssuer(CREDENTIAL_PROVIDER_ID),
          accountId: created.id,
          password: await context.password.hash(password),
        })
        await deps.audit?.record({
          action: "signup.created",
          outcome: "success",
          actorType: "system",
          target: { type: "user", id: created.id },
          metadata: { resetAdmin: true, role },
        })
        deps.logger.warn("admin account created by reset-admin", {
          email,
          role,
        })
        return {
          email,
          created: true,
          role,
          sessionsRevoked: 0,
          reactivated: false,
        }
      }

      // `findUserByEmail` is what resolves the address — it applies Better
      // Auth's own normalisation, so it finds the row a sign-in would find.
      // What it returns is the *base* user shape, without the columns D-14
      // added, so the row is re-read here through the schema that has them.
      const user = await loadUserRow(deps.database, existing.user.id)
      if (!user) {
        throw new ResetAdminError(
          `${email} resolved to a user that no longer exists. Run this again.`
        )
      }

      if (!isAdmin(user.role, adminRoles)) {
        throw new ResetAdminError(
          `${email} exists but holds no admin role, and this command does not grant one. ` +
            "Grant it from another administrator in /admin/users, or point " +
            "`admin.bootstrap.email` at an address that already has one."
        )
      }

      const hash = await context.password.hash(password)
      const { account, session } = deps.database.schema
      const updated = await deps.database.db
        .update(account)
        .set({ password: hash, updatedAt: new Date() })
        .where(
          and(
            eq(account.userId, user.id),
            eq(account.providerId, CREDENTIAL_PROVIDER_ID)
          )
        )
        .returning({ id: account.id })

      // An admin who only ever signed in with Google has no credential row to
      // update. Creating one is the point: this command is what makes a
      // password sign-in possible again.
      if (updated.length === 0) {
        await context.internalAdapter.createAccount({
          userId: user.id,
          providerId: CREDENTIAL_PROVIDER_ID,
          issuer: createLocalAccountIssuer(CREDENTIAL_PROVIDER_ID),
          accountId: user.id,
          password: hash,
        })
      }

      const wasUnreachable = user.status !== "active" || user.banned === true

      await context.internalAdapter.updateUser(user.id, {
        mustChangePassword: true,
        emailVerified: true,
        status: "active",
        banned: false,
        banReason: null,
        banExpires: null,
      })

      const revoked = await deps.database.db
        .delete(session)
        .where(eq(session.userId, user.id))
        .returning({ id: session.id })

      // `password.reset_completed` rather than an action of its own: to
      // everything that reads the trail this *is* a completed reset, and the
      // metadata says which door it came through.
      await deps.audit?.record({
        action: "password.reset_completed",
        outcome: "success",
        actorType: "system",
        target: { type: "user", id: user.id },
        metadata: {
          resetAdmin: true,
          credentialCreated: updated.length === 0,
          reactivated: wasUnreachable,
          sessionsRevoked: revoked.length,
        },
      })

      deps.logger.warn("admin password reset", {
        email,
        sessionsRevoked: revoked.length,
        reactivated: wasUnreachable,
        hint: "Sign in with the configured bootstrap password; that sign-in must change it.",
      })

      return {
        email,
        created: false,
        role: user.role ?? adminRoles[0] ?? "admin",
        sessionsRevoked: revoked.length,
        reactivated: wasUnreachable,
      }
    }
  )

  // `withAdvisoryLock` returns `undefined` only for `skipIfLocked`, which this
  // caller does not pass — waiting is right here, since the competing holder is
  // a start-up doing very nearly the same thing.
  if (!result) throw new ResetAdminError("The reset did not run.")
  return result
}
