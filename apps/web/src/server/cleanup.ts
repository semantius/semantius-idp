/**
 * The retention job (OPS-8, DM-5).
 *
 * Nine tables in this schema grow without bound and nothing has ever emptied
 * them. Most are small; two are not. `verification` takes a row for every
 * password-reset link, every e-mail verification **and every authorization
 * code** — 1.7.1's oauth-provider stores codes through
 * `createVerificationValue`, so on a busy deployment that table grows once per
 * sign-in through a client. `rate_limit` takes a row per key per window and
 * keeps it for ever.
 *
 * **What is deleted, and the reason in each case** — never "old", always
 * *no longer capable of doing anything*:
 *
 * | table                      | when                                            |
 * | -------------------------- | ----------------------------------------------- |
 * | `session`                  | expired                                         |
 * | `verification`             | expired — reset links, verifications, **codes** |
 * | `oauth_access_token`       | dead ≥ 30 days (expired or revoked)             |
 * | `oauth_refresh_token`      | dead ≥ 30 days (expired or revoked)             |
 * | `oauth_client_assertion`   | expired — the JTI replay window is over         |
 * | `pending_authorization`    | expired (D33: written by nothing, swept anyway) |
 * | `rate_limit`               | untouched for a day, so past every window       |
 * | `jwks`                     | expired **plus** `jwt.gracePeriod`              |
 * | `audit_log`                | older than `audit.retentionDays`                |
 *
 * **The 30-day delay on token rows is not caution, it is evidence.** A revoked
 * token that is still in the table is the answer to "was this token revoked,
 * or did it never exist?" — which is the first question asked after a
 * suspected leak. Delete the row and both cases look identical. DM-5 names 30
 * days; that is the window in which someone is still investigating.
 *
 * **`jwks` is the one row that must not be deleted early.** A key stops
 * signing at `expiresAt` but keeps *verifying* until the grace period ends —
 * that is the whole mechanism `rotate-keys.ts` relies on, and the grace period
 * defaults to the longest token lifetime plus an hour precisely so a token
 * signed just before a rotation still verifies after it. Purging on `expiresAt`
 * alone would invalidate live tokens on a schedule.
 *
 * Under `LOCK_KEYS.cleanup` on the **direct** connection, with `skipIfLocked`:
 * if another instance is already sweeping there is nothing to wait for (D27).
 */

import { and, isNotNull, lt, or, sql } from "drizzle-orm"

import type { IdpConfig } from "./config/derive"
import { withAdvisoryLock } from "./db/advisory-lock"
import type { DbHandle } from "./db/client"
import type { Logger } from "./logger"

/** DM-5: how long a dead token row is kept as evidence. */
export const TOKEN_GRACE_DAYS = 30

/**
 * How long a `rate_limit` row must be untouched before it is stale.
 *
 * A day, which is orders of magnitude past the longest window this deployment
 * configures (five minutes, for the password-reset bucket). Deleting a row
 * inside its window would hand the caller a fresh allowance, so the margin is
 * deliberately absurd rather than merely sufficient.
 */
export const RATE_LIMIT_STALE_HOURS = 24

export interface CleanupCounts {
  sessions: number
  /** Reset links, e-mail verifications and OAuth authorization codes. */
  verifications: number
  accessTokens: number
  refreshTokens: number
  clientAssertions: number
  pendingAuthorizations: number
  rateLimits: number
  signingKeys: number
  auditEvents: number
}

export interface CleanupDeps {
  config: IdpConfig
  /** The pooled handle: the deletes run here. */
  database: DbHandle
  /** Direct, non-pooled: the advisory lock lives on this one (D27). */
  locking: DbHandle
  logger: Logger
}

const EMPTY: CleanupCounts = {
  sessions: 0,
  verifications: 0,
  accessTokens: 0,
  refreshTokens: 0,
  clientAssertions: 0,
  pendingAuthorizations: 0,
  rateLimits: 0,
  signingKeys: 0,
  auditEvents: 0,
}

/** Whether anything at all was deleted, for the log line. */
export function cleanupTotal(counts: CleanupCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0)
}

function minus(now: Date, seconds: number): Date {
  return new Date(now.getTime() - seconds * 1000)
}

/**
 * Deletes everything DM-5 names, and returns what it removed.
 *
 * Returns `undefined` when another instance holds the lock — the caller logs
 * nothing in that case, because "someone else is doing it" is not an event.
 */
export async function runCleanup(
  deps: CleanupDeps,
  options: { now?: Date; wait?: boolean } = {}
): Promise<CleanupCounts | undefined> {
  const now = options.now ?? new Date()

  return withAdvisoryLock(
    deps.locking.sql,
    "cleanup",
    () => sweep(deps, now),
    // The interval job skips; `idp cleanup` waits, because an operator who
    // typed the command wants it to have happened when it returns.
    options.wait ? {} : { skipIfLocked: true }
  )
}

async function sweep(deps: CleanupDeps, now: Date): Promise<CleanupCounts> {
  const { db, schema } = deps.database
  const counts: CleanupCounts = { ...EMPTY }

  const tokenCutoff = minus(now, TOKEN_GRACE_DAYS * 86_400)
  const rateLimitCutoff = minus(now, RATE_LIMIT_STALE_HOURS * 3600)
  const auditCutoff = minus(
    now,
    deps.config.file.audit.retentionDays * 86_400
  )

  counts.sessions = await removed(
    db.delete(schema.session).where(lt(schema.session.expiresAt, now))
  )

  counts.verifications = await removed(
    db.delete(schema.verification).where(lt(schema.verification.expiresAt, now))
  )

  // Access tokens before refresh tokens: `oauth_access_token.refresh_id`
  // cascades from `oauth_refresh_token`, so doing it the other way round would
  // silently remove access rows the count never mentions.
  counts.accessTokens = await removed(
    db
      .delete(schema.oauthAccessToken)
      .where(
        or(
          lt(schema.oauthAccessToken.expiresAt, tokenCutoff),
          and(
            isNotNull(schema.oauthAccessToken.revoked),
            lt(schema.oauthAccessToken.revoked, tokenCutoff)
          )
        )
      )
  )

  counts.refreshTokens = await removed(
    db
      .delete(schema.oauthRefreshToken)
      .where(
        or(
          lt(schema.oauthRefreshToken.expiresAt, tokenCutoff),
          and(
            isNotNull(schema.oauthRefreshToken.revoked),
            lt(schema.oauthRefreshToken.revoked, tokenCutoff)
          )
        )
      )
  )

  counts.clientAssertions = await removed(
    db
      .delete(schema.oauthClientAssertion)
      .where(lt(schema.oauthClientAssertion.expiresAt, now))
  )

  counts.pendingAuthorizations = await removed(
    db
      .delete(schema.pendingAuthorization)
      .where(lt(schema.pendingAuthorization.expiresAt, now))
  )

  // `last_request` is epoch milliseconds in a bigint, not a timestamp — the
  // column is Better Auth's, and comparing it to a `Date` would compare a
  // number with a string.
  counts.rateLimits = await removed(
    db
      .delete(schema.rateLimit)
      .where(lt(schema.rateLimit.lastRequest, rateLimitCutoff.getTime()))
  )

  // Expiry **plus** the grace period, and never on expiry alone: a retired key
  // still verifies tokens signed before it stepped down. A key with no
  // `expires_at` is the live one, and `lt` on a null column yields null, so it
  // is never a candidate.
  //
  // The grace is subtracted from `now` rather than added to the column, which
  // is the same inequality and avoids a raw ``sql`${col} + interval` `` — a
  // template like that binds the `Date` with no type and postgres.js refuses
  // it. That exact mistake cost M10 a 500 on the whole dashboard; there is no
  // reason to make it twice.
  const keyCutoff = minus(now, deps.config.jwksGracePeriodSeconds)
  counts.signingKeys = await removed(
    db.delete(schema.jwks).where(lt(schema.jwks.expiresAt, keyCutoff))
  )

  counts.auditEvents = await removed(
    db.delete(schema.auditLog).where(lt(schema.auditLog.createdAt, auditCutoff))
  )

  return counts
}

/** Drizzle's `returning()` is how a delete reports how many rows it removed. */
async function removed(
  query: { returning: (columns: { id: never }) => Promise<unknown[]> }
): Promise<number> {
  const rows = await query.returning({ id: sql`1` as never })
  return rows.length
}

/**
 * How far either side of the interval a run may drift.
 *
 * Jitter exists so that two processes started by the same orchestrator at the
 * same second do not sweep in lockstep for ever. The lock already makes a
 * collision harmless — the loser skips — but a deployment where one instance
 * always wins is one where the other never runs at all, and a job that has
 * never run is a job nobody knows is broken.
 */
export const CLEANUP_JITTER = 0.1

export interface CleanupJob {
  /** Stops the schedule. Idempotent; safe to call during shutdown. */
  stop: () => void
}

/**
 * Runs {@link runCleanup} on a schedule (OPS-8).
 *
 * **Not `setInterval`.** A sweep can outlast its own interval on a large
 * database, and `setInterval` would then queue the next one behind it and the
 * one after that. Each run schedules the next when it *finishes*, so the gap
 * is a gap rather than a deadline.
 *
 * The timer is `unref`'d: a pending sweep must never be the reason a process
 * refuses to exit. A failure is logged and the schedule continues — a
 * retention job that stops for ever after one bad night is worse than one that
 * misses a night.
 */
export function startCleanupJob(
  deps: CleanupDeps,
  options: { random?: () => number } = {}
): CleanupJob {
  const random = options.random ?? Math.random
  const intervalMs = deps.config.file.cleanup.intervalMinutes * 60_000
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const next = (): void => {
    if (stopped) return
    const drift = 1 + (random() * 2 - 1) * CLEANUP_JITTER
    timer = setTimeout(() => void tick(), Math.round(intervalMs * drift))
    timer.unref()
  }

  const tick = async (): Promise<void> => {
    try {
      const counts = await runCleanup(deps)
      // `undefined` means another instance holds the lock, which is not an
      // event worth a line in anyone's log.
      if (counts && cleanupTotal(counts) > 0) {
        deps.logger.info("cleanup", { ...counts, total: cleanupTotal(counts) })
      }
    } catch (error) {
      deps.logger.error("cleanup failed", { err: error })
    }
    next()
  }

  next()
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
