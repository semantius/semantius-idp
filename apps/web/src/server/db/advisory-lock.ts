/**
 * Postgres advisory locks (OPS-2, OPS-5, OPS-8, FR-ADMIN-1, FR-OIDC-2/16).
 *
 * Every startup step that mutates shared state — migrating, generating the
 * first signing key, reconciling clients, creating the bootstrap admin, the
 * cleanup job — runs inside one of these. Single-instance is the supported
 * topology (OPS-11), but an accidental second replica must not corrupt
 * anything, and two containers restarting together is the ordinary case.
 *
 * **Session-scoped, not transaction-scoped, and deliberately so:** the locked
 * work spans several statements and its own transactions (a migration is not
 * one transaction). That means the lock is tied to the *connection*, so it must
 * be taken and released on the same one — hence the dedicated single connection
 * below rather than a pooled `sql` call.
 *
 * ⚠ Behind a **transaction-mode connection pooler** (PgBouncer, Neon's
 * `-pooler` endpoint) a session lock has no stable session to live in and can
 * be released or attributed to another client. Measured, not assumed: with the
 * lock held on one reserved connection, `pg_try_advisory_lock` on a second
 * connection through Neon's pooled endpoint **succeeds**, and through the
 * direct endpoint is refused. Startup, migrations and the CLI therefore
 * connect through the *direct* endpoint (`database.directUrl`, **D27**).
 */

import type postgres from "postgres"

/**
 * Namespace for our lock keys, so an IdP lock can never collide with an
 * application lock in the same database. Arbitrary but fixed: "idp0" as ASCII.
 */
export const LOCK_NAMESPACE = 0x69647030

export const LOCK_KEYS = {
  migrate: 1,
  signingKey: 2,
  reconcileClients: 3,
  bootstrapAdmin: 4,
  cleanup: 5,
  rotateKeys: 6,
  /** FR-GW-2: the same discipline `reconcileClients` has, for the gateways. */
  reconcileGateways: 7,
} as const

export type LockName = keyof typeof LOCK_KEYS

export interface AdvisoryLockOptions {
  /** Give up after this long instead of waiting forever. Default: 60 s. */
  timeoutSeconds?: number
  /**
   * Return `false` instead of waiting when another instance holds the lock.
   * The cleanup job uses this: if someone else is already cleaning up, there is
   * nothing to wait for.
   */
  skipIfLocked?: boolean
}

export class AdvisoryLockTimeout extends Error {
  constructor(name: LockName, timeoutSeconds: number) {
    super(
      `Timed out after ${timeoutSeconds}s waiting for the \`${name}\` advisory lock. ` +
        "Another instance is probably still starting up; if none is, a previous run may have " +
        "left a stuck connection — check `pg_locks`."
    )
    this.name = "AdvisoryLockTimeout"
  }
}

/**
 * Runs `fn` while holding the named advisory lock, on a connection of its own.
 *
 * Returns `undefined` when `skipIfLocked` is set and the lock was already held.
 * The lock is always released, including when `fn` throws.
 */
export async function withAdvisoryLock<T>(
  sql: postgres.Sql,
  name: LockName,
  fn: () => Promise<T>,
  options: AdvisoryLockOptions = {}
): Promise<T | undefined> {
  const timeoutSeconds = options.timeoutSeconds ?? 60
  const key = LOCK_KEYS[name]

  // `reserve()` pins one connection for the whole critical section, which is
  // what makes a session-scoped lock meaningful.
  const connection = await sql.reserve()
  try {
    if (options.skipIfLocked) {
      const [row] = await connection<{ locked: boolean }[]>`
        select pg_try_advisory_lock(${LOCK_NAMESPACE}::int, ${key}::int) as locked
      `
      if (!row?.locked) return undefined
    } else {
      // `lock_timeout` turns an indefinite wait into an actionable error —
      // but only if it is actually set. `SET LOCAL` outside an explicit
      // transaction block is discarded by Postgres with a warning, and every
      // statement here runs in autocommit, so this used to leave the timeout
      // at 0 and wait for ever. A container starting while another instance
      // held the lock hung silently instead of failing with the message
      // below. Session-scoped `SET`, reset before the connection goes back to
      // the pool so the next borrower does not inherit it.
      await connection.unsafe(
        `set lock_timeout = '${timeoutSeconds * 1000}ms'`
      )
      try {
        await connection`select pg_advisory_lock(${LOCK_NAMESPACE}::int, ${key}::int)`
      } catch (error) {
        if (isLockTimeout(error))
          throw new AdvisoryLockTimeout(name, timeoutSeconds)
        throw error
      } finally {
        await connection.unsafe("reset lock_timeout")
      }
    }

    try {
      return await fn()
    } finally {
      await connection`select pg_advisory_unlock(${LOCK_NAMESPACE}::int, ${key}::int)`
    }
  } finally {
    connection.release()
  }
}

function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "55P03" // lock_not_available
  )
}
