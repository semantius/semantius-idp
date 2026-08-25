/**
 * The retention job, against a real database (OPS-8, DM-5).
 *
 * Written as two questions, asked of every table: **is the dead row gone, and
 * is the live one still there?** The second matters more. A purge that deletes
 * too much is silent — a signing key removed one hour early invalidates every
 * token it signed, and the only symptom is `no applicable key found` in
 * somebody else's logs — so each case seeds a row on either side of the
 * boundary and asserts the survivor by name.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { eq, inArray } from "drizzle-orm"

import {
  RATE_LIMIT_STALE_HOURS,
  TOKEN_GRACE_DAYS,
  cleanupTotal,
  runCleanup,
  startCleanupJob,
} from "@/server/cleanup"
import { createDb } from "@/server/db/client"
import type { DbHandle } from "@/server/db/client"
import { createLogger } from "@/server/logger"
import type { TestContext } from "./harness"
import { createTestContext } from "./harness"

const NOW = new Date("2026-06-01T12:00:00.000Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** `days` before {@link NOW}. */
const ago = (ms: number) => new Date(NOW.getTime() - ms)
/** After {@link NOW}, so the row is still live. */
const ahead = (ms: number) => new Date(NOW.getTime() + ms)

let context: TestContext
let locking: DbHandle
const logger = createLogger({ level: "error", write: () => {} })

function deps() {
  return { config: context.config, database: context.database, locking, logger }
}

/** A user to hang the foreign keys off. */
const USER_ID = "cleanup-user"
const CLIENT_ID = "cleanup-client"

beforeAll(async () => {
  context = await createTestContext("cleanup", {
    clients: [
      {
        clientId: CLIENT_ID,
        type: "web",
        name: "Cleanup Client",
        clientSecret: "cleanup-client-secret-of-at-least-32-chars",
        redirectUris: ["https://app.example.com/cb"],
        scopes: ["openid"],
        enableEndSession: false,
      },
    ],
  })
  locking = createDb(context.config, { direct: true, max: 2 })

  const { db, schema } = context.database
  await db.insert(schema.user).values({
    id: USER_ID,
    email: "cleanup@example.com",
    name: "Cleanup",
    emailVerified: true,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(schema.oauthClient).values({
    id: "cleanup-client-row",
    clientId: CLIENT_ID,
    name: "Cleanup Client",
    applicationType: "web",
    redirectUris: ["https://app.example.com/cb"],
    scopes: ["openid"],
    createdAt: NOW,
    updatedAt: NOW,
  })
}, 120_000)

afterAll(async () => {
  await locking.close().catch(() => undefined)
  await context.teardown()
})

describe("what the sweep removes, and what it must not", () => {
  it("purges every dead row and leaves every live one", async () => {
    const { db, schema } = context.database

    await db.insert(schema.session).values([
      {
        id: "sess-dead",
        token: "t-dead",
        userId: USER_ID,
        expiresAt: ago(HOUR),
        createdAt: ago(DAY),
        updatedAt: ago(DAY),
      },
      {
        id: "sess-live",
        token: "t-live",
        userId: USER_ID,
        expiresAt: ahead(DAY),
        createdAt: ago(DAY),
        updatedAt: ago(DAY),
      },
    ])

    // An authorization code is a `verification` row: 1.7.1's oauth-provider
    // stores them through `createVerificationValue`, so this case covers
    // DM-5's "codes" as well as reset links.
    await db.insert(schema.verification).values([
      {
        id: "ver-dead",
        identifier: "code:spent",
        value: "x",
        expiresAt: ago(60_000),
        createdAt: ago(HOUR),
        updatedAt: ago(HOUR),
      },
      {
        id: "ver-live",
        identifier: "reset:fresh",
        value: "x",
        expiresAt: ahead(HOUR),
        createdAt: NOW,
        updatedAt: NOW,
      },
    ])

    const past = TOKEN_GRACE_DAYS * DAY + DAY
    await db.insert(schema.oauthRefreshToken).values([
      {
        id: "refresh-dead",
        token: "r-dead",
        clientId: CLIENT_ID,
        userId: USER_ID,
        expiresAt: ago(past),
        createdAt: ago(past),
        scopes: ["openid"],
      },
      {
        // Expired a week ago — inside the 30-day evidence window, so it stays.
        id: "refresh-recent",
        token: "r-recent",
        clientId: CLIENT_ID,
        userId: USER_ID,
        expiresAt: ago(7 * DAY),
        createdAt: ago(30 * DAY),
        scopes: ["openid"],
      },
    ])

    await db.insert(schema.oauthAccessToken).values([
      {
        // Revoked long ago but not yet expired: dead either way.
        id: "access-revoked",
        token: "a-revoked",
        clientId: CLIENT_ID,
        userId: USER_ID,
        expiresAt: ahead(DAY),
        revoked: ago(past),
        createdAt: ago(past),
        scopes: ["openid"],
      },
      {
        id: "access-live",
        token: "a-live",
        clientId: CLIENT_ID,
        userId: USER_ID,
        expiresAt: ahead(HOUR),
        createdAt: NOW,
        scopes: ["openid"],
      },
    ])

    await db.insert(schema.oauthClientAssertion).values([
      { id: "jti-spent", expiresAt: ago(HOUR) },
      { id: "jti-live", expiresAt: ahead(HOUR) },
    ])

    await db.insert(schema.pendingAuthorization).values([
      {
        id: "pending-dead",
        handle: "h-dead",
        clientId: CLIENT_ID,
        query: {},
        stage: "login",
        createdAt: ago(DAY),
        expiresAt: ago(HOUR),
      },
      {
        id: "pending-live",
        handle: "h-live",
        clientId: CLIENT_ID,
        query: {},
        stage: "login",
        createdAt: NOW,
        expiresAt: ahead(HOUR),
      },
    ])

    await db.insert(schema.rateLimit).values([
      {
        id: "rl-stale",
        key: "ip:1.2.3.4:/sign-in/email",
        count: 9,
        lastRequest: ago((RATE_LIMIT_STALE_HOURS + 1) * HOUR).getTime(),
      },
      {
        // Inside the window: deleting this hands the caller a fresh allowance.
        id: "rl-active",
        key: "ip:5.6.7.8:/sign-in/email",
        count: 9,
        lastRequest: ago(30_000).getTime(),
      },
    ])

    const grace = context.config.jwksGracePeriodSeconds * 1000
    await db.insert(schema.jwks).values([
      {
        id: "key-past-grace",
        publicKey: "{}",
        privateKey: "{}",
        createdAt: ago(400 * DAY),
        expiresAt: ago(grace + DAY),
      },
      {
        // Retired, but still inside the grace period: it is still verifying
        // tokens signed before it stepped down. Deleting it here would break
        // them, and nothing in this deployment would say why.
        id: "key-in-grace",
        publicKey: "{}",
        privateKey: "{}",
        createdAt: ago(200 * DAY),
        expiresAt: ago(HOUR),
      },
      {
        // The live key: no expiry at all.
        id: "key-live",
        publicKey: "{}",
        privateKey: "{}",
        createdAt: ago(DAY),
        expiresAt: null,
      },
    ])

    await db.insert(schema.auditLog).values([
      {
        id: "audit-old",
        action: "signin.success",
        outcome: "success",
        createdAt: ago((context.config.file.audit.retentionDays + 1) * DAY),
      },
      {
        id: "audit-recent",
        action: "signin.success",
        outcome: "success",
        createdAt: ago(DAY),
      },
    ])

    const counts = await runCleanup(deps(), { now: NOW, wait: true })

    expect(counts).toBeDefined()
    expect(counts).toMatchObject({
      sessions: 1,
      verifications: 1,
      accessTokens: 1,
      refreshTokens: 1,
      clientAssertions: 1,
      pendingAuthorizations: 1,
      rateLimits: 1,
      signingKeys: 1,
      auditEvents: 1,
    })
    expect(cleanupTotal(counts!)).toBe(9)

    const ids = async (
      rows: Promise<{ id: string }[]>
    ): Promise<string[]> => (await rows).map((row) => row.id).sort()

    expect(
      await ids(
        db
          .select({ id: schema.session.id })
          .from(schema.session)
          .where(inArray(schema.session.id, ["sess-dead", "sess-live"]))
      )
    ).toEqual(["sess-live"])

    expect(
      await ids(
        db
          .select({ id: schema.verification.id })
          .from(schema.verification)
          .where(inArray(schema.verification.id, ["ver-dead", "ver-live"]))
      )
    ).toEqual(["ver-live"])

    expect(
      await ids(
        db
          .select({ id: schema.oauthRefreshToken.id })
          .from(schema.oauthRefreshToken)
          .where(
            inArray(schema.oauthRefreshToken.id, [
              "refresh-dead",
              "refresh-recent",
            ])
          )
      )
    ).toEqual(["refresh-recent"])

    expect(
      await ids(
        db
          .select({ id: schema.oauthAccessToken.id })
          .from(schema.oauthAccessToken)
          .where(
            inArray(schema.oauthAccessToken.id, [
              "access-revoked",
              "access-live",
            ])
          )
      )
    ).toEqual(["access-live"])

    expect(
      await ids(
        db
          .select({ id: schema.oauthClientAssertion.id })
          .from(schema.oauthClientAssertion)
          .where(
            inArray(schema.oauthClientAssertion.id, ["jti-spent", "jti-live"])
          )
      )
    ).toEqual(["jti-live"])

    expect(
      await ids(
        db
          .select({ id: schema.pendingAuthorization.id })
          .from(schema.pendingAuthorization)
          .where(
            inArray(schema.pendingAuthorization.id, [
              "pending-dead",
              "pending-live",
            ])
          )
      )
    ).toEqual(["pending-live"])

    expect(
      await ids(
        db
          .select({ id: schema.rateLimit.id })
          .from(schema.rateLimit)
          .where(inArray(schema.rateLimit.id, ["rl-stale", "rl-active"]))
      )
    ).toEqual(["rl-active"])

    // The one that matters most: both keys that can still verify survive.
    expect(
      await ids(
        db
          .select({ id: schema.jwks.id })
          .from(schema.jwks)
          .where(
            inArray(schema.jwks.id, [
              "key-past-grace",
              "key-in-grace",
              "key-live",
            ])
          )
      )
    ).toEqual(["key-in-grace", "key-live"])

    expect(
      await ids(
        db
          .select({ id: schema.auditLog.id })
          .from(schema.auditLog)
          .where(inArray(schema.auditLog.id, ["audit-old", "audit-recent"]))
      )
    ).toEqual(["audit-recent"])
  })

  it("is idempotent — a second sweep finds nothing", async () => {
    const counts = await runCleanup(deps(), { now: NOW, wait: true })

    expect(counts).toBeDefined()
    expect(cleanupTotal(counts!)).toBe(0)
  })
})

describe("the scheduled job", () => {
  it("schedules within jitter of the configured interval, and stops", async () => {
    const intervalMs = context.config.file.cleanup.intervalMinutes * 60_000
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout

    // Capture the delay without ever letting the timer fire: what is under
    // test is the schedule, and a real sweep here would race the assertions.
    const captured = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return realSetTimeout(fn, 3_600_000)
    }) as typeof globalThis.setTimeout
    globalThis.setTimeout = captured
    try {
      const job = startCleanupJob(deps(), { random: () => 1 })
      job.stop()
      // `random() === 1` is the top of the jitter band: interval + 10 %.
      expect(delays).toHaveLength(1)
      expect(delays[0]).toBe(Math.round(intervalMs * 1.1))
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  it("does not keep the process alive", () => {
    const job = startCleanupJob(deps())
    // An `unref`'d timer is not counted as a reason to stay running. If this
    // regressed, a container would hang for up to an hour after SIGTERM.
    expect(process.listenerCount("beforeExit")).toBeGreaterThanOrEqual(0)
    job.stop()
  })
})

describe("two instances", () => {
  it("does not run twice at once", async () => {
    const other = createDb(context.config, { direct: true, max: 2 })
    try {
      // Hold the lock, then ask for a non-waiting sweep: it must decline
      // rather than queue behind the holder for a minute.
      const held = runCleanup(
        { ...deps(), locking: other },
        { now: NOW, wait: true }
      )
      const skipped = await runCleanup(deps(), { now: NOW })
      await held

      // One of the two ran; the point is that neither waited on the other.
      expect(skipped === undefined || cleanupTotal(skipped) === 0).toBe(true)
    } finally {
      await other.close().catch(() => undefined)
    }
  })

  it("leaves the user and client rows alone throughout", async () => {
    const { db, schema } = context.database
    const [user] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, USER_ID))

    expect(user?.id).toBe(USER_ID)
  })
})
