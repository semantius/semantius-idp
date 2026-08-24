import { afterAll, beforeAll, describe, expect, it } from "vitest"

import postgres from "postgres"

import {
  AdvisoryLockTimeout,
  LOCK_KEYS,
  LOCK_NAMESPACE,
  withAdvisoryLock,
} from "@/server/db/advisory-lock"
import { testDatabaseUrl } from "./harness"

/**
 * D27 / OPS-2 — the locks every mutating startup step depends on.
 *
 * S4 established that a session advisory lock does not hold through a
 * transaction pooler, which is why `database.directUrl` exists. What it did
 * not establish is what happens when the lock *is* held: the answer was "wait
 * for ever". `SET LOCAL lock_timeout` outside an explicit transaction block is
 * discarded by Postgres with a warning, and every statement here runs in
 * autocommit, so the timeout was never applied. A second container starting up
 * hung silently instead of failing with the actionable message the code
 * already carried.
 *
 * These run against the direct connection for the same reason the startup
 * steps do.
 */
describe("advisory locks (D27)", () => {
  let holder: postgres.Sql
  let waiter: postgres.Sql
  const NAMESPACE = LOCK_NAMESPACE

  beforeAll(() => {
    const url = testDatabaseUrl()
    const ssl = url.includes("localhost") ? undefined : ("require" as const)
    holder = postgres(url, { max: 1, ssl })
    waiter = postgres(url, { max: 2, ssl })
  })

  afterAll(async () => {
    await holder.end()
    await waiter.end()
  })

  it("gives up with an actionable error rather than waiting for ever", async () => {
    const key = LOCK_KEYS.cleanup
    const pinned = await holder.reserve()
    await pinned`select pg_advisory_lock(${NAMESPACE}::int, ${key}::int)`

    try {
      const started = Date.now()
      await expect(
        withAdvisoryLock(waiter, "cleanup", async () => "never runs", {
          timeoutSeconds: 2,
        })
      ).rejects.toBeInstanceOf(AdvisoryLockTimeout)
      const waited = Date.now() - started

      // The point of the test: it *returns*. Generously bounded, because the
      // failure mode is not "slightly late", it is "never".
      expect(waited).toBeLessThan(30_000)
    } finally {
      await pinned`select pg_advisory_unlock(${NAMESPACE}::int, ${key}::int)`
      pinned.release()
    }
  }, 60_000)

  it("names the lock in the error, so the operator knows what to look for", async () => {
    const key = LOCK_KEYS.migrate
    const pinned = await holder.reserve()
    await pinned`select pg_advisory_lock(${NAMESPACE}::int, ${key}::int)`

    try {
      await expect(
        withAdvisoryLock(waiter, "migrate", async () => undefined, {
          timeoutSeconds: 1,
        })
      ).rejects.toThrow(/`migrate` advisory lock/)
    } finally {
      await pinned`select pg_advisory_unlock(${NAMESPACE}::int, ${key}::int)`
      pinned.release()
    }
  }, 60_000)

  it("skips instead of waiting when asked to (the cleanup job's contract)", async () => {
    const key = LOCK_KEYS.cleanup
    const pinned = await holder.reserve()
    await pinned`select pg_advisory_lock(${NAMESPACE}::int, ${key}::int)`

    try {
      let ran = false
      const result = await withAdvisoryLock(
        waiter,
        "cleanup",
        async () => {
          ran = true
          return "should not run"
        },
        { skipIfLocked: true }
      )
      // If someone else is already cleaning up there is nothing to wait for.
      expect(result).toBeUndefined()
      expect(ran).toBe(false)
    } finally {
      await pinned`select pg_advisory_unlock(${NAMESPACE}::int, ${key}::int)`
      pinned.release()
    }
  }, 60_000)

  it("runs the body and releases, so the next caller is not blocked", async () => {
    const first = await withAdvisoryLock(waiter, "signingKey", async () => "a")
    expect(first).toBe("a")
    // Would time out if the first call leaked the lock.
    const second = await withAdvisoryLock(waiter, "signingKey", async () => "b", {
      timeoutSeconds: 5,
    })
    expect(second).toBe("b")
  }, 60_000)

  it("releases the lock even when the body throws", async () => {
    await expect(
      withAdvisoryLock(waiter, "rotateKeys", async () => {
        throw new Error("body failed")
      })
    ).rejects.toThrow("body failed")

    const after = await withAdvisoryLock(waiter, "rotateKeys", async () => "ok", {
      timeoutSeconds: 5,
    })
    expect(after).toBe("ok")
  }, 60_000)

  it("leaves no lock_timeout behind on a pooled connection", async () => {
    // The timeout is session-scoped now, not statement-scoped, so it has to be
    // reset — otherwise the next borrower of that connection inherits it and
    // some unrelated query starts failing at two seconds.
    await withAdvisoryLock(waiter, "bootstrapAdmin", async () => undefined, {
      timeoutSeconds: 2,
    })
    const rows = await waiter<{ lock_timeout: string }[]>`show lock_timeout`
    expect(rows[0]!.lock_timeout).toBe("0")
  }, 60_000)
})
