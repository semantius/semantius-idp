/**
 * A fixed-window limiter for the buckets Better Auth cannot key (SEC-2).
 *
 * **Why this exists at all.** Better Auth's own limiter is good and is used for
 * everything it can express — but it builds its key as `ip:path`, always, and
 * `rateLimit.customRules` can only change the *window and the maximum* for a
 * path, never the key. SEC-2 requires `/oauth2/token` to be limited **per
 * client id as well as per IP**, and a confidential client behind one NAT is a
 * single IP for thousands of users: the per-IP bucket is either so wide it
 * limits nothing or so narrow it breaks the client. So the per-client bucket
 * is ours.
 *
 * It writes to the **same `rate_limit` table**, with a prefixed key, so there
 * is one thing to clean up (M12's job already sweeps it) and one thing to look
 * at when a limit is behaving oddly. The prefix is what keeps the two
 * namespaces from colliding.
 *
 * **Fixed window, not sliding.** The same choice Better Auth makes, and for
 * the same reason: one row per key, one statement to check and increment. A
 * fixed window lets through at most 2× the maximum across a boundary, which
 * for a credential endpoint is an acceptable amount of slack in exchange for
 * not keeping a list of timestamps per client.
 *
 * Failing open is deliberate and narrow. If the *database* cannot be reached
 * the limiter allows the request, because a limiter that turns a database
 * blip into a total outage of the token endpoint is a worse failure than the
 * one it is guarding against — and every request it lets through still has to
 * pass authentication. The failure is logged at `error`.
 */

import { eq, sql } from "drizzle-orm"

import type { DbHandle } from "../db/client"
import type { Logger } from "../logger"

/** Marks these rows as ours rather than Better Auth's. */
const KEY_PREFIX = "idp:"

export interface RateLimitRule {
  /** Seconds. */
  window: number
  /** Requests permitted per window. */
  max: number
}

export interface RateLimitDecision {
  allowed: boolean
  /** Seconds until the window resets. Only meaningful when refused. */
  retryAfter: number
}

export interface RateLimitDeps {
  database: DbHandle
  logger?: Logger
  /** Injectable for tests; nothing else should pass it. */
  now?: () => number
}

/**
 * Counts one request against a bucket and says whether it may proceed.
 *
 * The check and the increment are one statement. Doing them as a read and then
 * a write means every concurrent request reads the same stale count and the
 * limit is whatever the concurrency happens to be — which is exactly the
 * situation an attacker creates on purpose.
 */
export async function consume(
  deps: RateLimitDeps,
  bucket: string,
  rule: RateLimitRule
): Promise<RateLimitDecision> {
  const key = `${KEY_PREFIX}${bucket}`
  const now = (deps.now ?? Date.now)()
  const windowMs = rule.window * 1000
  const { rateLimit } = deps.database.schema

  try {
    const rows = await deps.database.db
      .insert(rateLimit)
      .values({ id: key, key, count: 1, lastRequest: now })
      .onConflictDoUpdate({
        target: rateLimit.key,
        set: {
          // Past the window, the row *is* a new window: reset rather than
          // delete, so there is no gap where two callers both insert.
          count: sql`case
            when ${rateLimit.lastRequest} + ${windowMs} <= ${now} then 1
            else ${rateLimit.count} + 1
          end`,
          lastRequest: sql`case
            when ${rateLimit.lastRequest} + ${windowMs} <= ${now} then ${now}
            else ${rateLimit.lastRequest}
          end`,
        },
      })
      .returning({
        count: rateLimit.count,
        lastRequest: rateLimit.lastRequest,
      })

    const row = rows[0]
    if (!row) return { allowed: true, retryAfter: 0 }

    if (row.count <= rule.max) return { allowed: true, retryAfter: 0 }

    const elapsed = now - row.lastRequest
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
    }
  } catch (error) {
    deps.logger?.error("rate limit check failed; allowing the request", {
      error: error instanceof Error ? error.message : String(error),
      bucket,
    })
    return { allowed: true, retryAfter: 0 }
  }
}

/** Forgets a bucket. Used by tests and by nothing else. */
export async function reset(
  deps: RateLimitDeps,
  bucket: string
): Promise<void> {
  const { rateLimit } = deps.database.schema
  await deps.database.db
    .delete(rateLimit)
    .where(eq(rateLimit.key, `${KEY_PREFIX}${bucket}`))
}

/**
 * The 429 a refused caller gets.
 *
 * `Retry-After` and nothing else: SEC-2 says the response must not reveal the
 * threshold, so there is no `X-RateLimit-Limit` here and no count in the body.
 * Knowing the limit is knowing exactly how much to do without tripping it.
 */
export function tooManyRequests(retryAfter: number): Response {
  return new Response(
    JSON.stringify({
      error: "slow_down",
      error_description: "Too many requests. Try again shortly.",
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(Math.max(1, Math.ceil(retryAfter))),
        "cache-control": "no-store",
      },
    }
  )
}
