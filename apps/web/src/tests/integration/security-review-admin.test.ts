/**
 * Security review 2026-09, stream S2: the admin API, the audit trail and the
 * SQL console.
 *
 * Each case here failed on the code it was written against, and that run is
 * recorded in `docs/security-review-2026-09.md`. Four findings:
 *
 *  - `/admin/update-user` with `data: { status: "pending" }`
 *    walked past the last-admin and self-action invariants, because the guard
 *    mapped only `banned`, `rejected` and `role`; and the body reached every
 *    column of the `user` table.
 *  - the console's READ ONLY transaction is not a privilege
 *    boundary for a superuser, so start-up now says so when the connection
 *    is one.
 *  - the recorded statement in `database.queried` carried every
 *    pasted literal verbatim, and `actorType` said `session` for an API key.
 *  - Three bug fixes: the first administrator's address in the log, the
 *    console flag in the anonymous UI context (unit-tested), and an
 *    `ipAddress` a caller could hand the audit writer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { desc, eq } from "drizzle-orm"

import { createLocalAccountIssuer } from "@better-auth/core/db"

import { createFirstUser } from "@/server/admin/first-user"
import { createAudit } from "@/server/audit"
import type { AuditEvent } from "@/server/audit"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { createLogger } from "@/server/logger"
import type { LogFields } from "@/server/logger"
import { runStartup } from "@/server/startup"
import { authRequest, createTestContext, sessionCookie } from "./harness"
import type { TestContext } from "./harness"

const PASSWORD = "correct-horse-battery-staple"

/** Creates a user directly, so the test controls status and roles exactly. */
async function makeUser(
  ctx: TestContext,
  email: string,
  { role, status = "active" }: { role?: string; status?: string } = {}
): Promise<string> {
  const context = await ctx.auth.$context
  const user = await createUserWithoutRequest(
    context,
    {
      email,
      name: email,
      emailVerified: true,
      ...(role ? { role } : {}),
      status,
    },
    { method: "admin" }
  )
  await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: user.id,
    password: await context.password.hash(PASSWORD),
  })
  return user.id
}

async function signIn(ctx: TestContext, email: string): Promise<string> {
  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
  )
  const cookie = sessionCookie(response)
  expect(cookie, `sign-in failed for ${email}`).toBeTruthy()
  return cookie!
}

async function post(
  ctx: TestContext,
  path: string,
  json: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return ctx.auth.handler(authRequest(path, { json, headers }))
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json().catch(() => null)) as unknown
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {}
}

async function userRow(ctx: TestContext, id: string) {
  const [row] = await ctx.database.db
    .select()
    .from(ctx.database.schema.user)
    .where(eq(ctx.database.schema.user.id, id))
  return row!
}

async function createKey(ctx: TestContext, cookie: string): Promise<string> {
  const created = await post(ctx, "/api-key/create", { name: "ops" }, { cookie })
  expect(created.status).toBe(200)
  const key = (await bodyOf(created)).key as string
  expect(key).toBeTruthy()
  return key
}

/** Collects structured log lines the way `startup.test.ts` does. */
function collectingLogger() {
  const lines: { level: string; msg: string; fields: LogFields }[] = []
  const logger = createLogger({
    level: "trace",
    write: (line) => {
      const record = JSON.parse(line) as { level: string; msg: string } & LogFields
      const { level, msg, time: _t, ...fields } = record
      lines.push({ level, msg, fields })
    },
  })
  return { logger, lines, text: () => JSON.stringify(lines) }
}

describe("/admin/update-user and the invariants", () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestContext("secrev-update-user", {
      config: { auth: { requireEmailVerification: false } },
    })
  })
  afterEach(async () => await ctx.teardown())

  it("refuses `status: pending` on the last administrator, like a ban", async () => {
    const only = await makeUser(ctx, "only@example.com", { role: "admin" })
    const cookie = await signIn(ctx, "only@example.com")

    // The reachable last-admin case is the self case (`admin.test.ts` says
    // why), and the last-admin rule is ordered first.
    const response = await post(
      ctx,
      "/admin/update-user",
      { userId: only, data: { status: "pending" } },
      { cookie }
    )
    expect(response.status).toBe(403)
    expect((await bodyOf(response)).code).toBe("LAST_ADMIN_PROTECTED")
    expect((await userRow(ctx, only)).status).toBe("active")
  })

  it("refuses `status: pending` on oneself when a colleague exists", async () => {
    const self = await makeUser(ctx, "self@example.com", { role: "admin" })
    await makeUser(ctx, "spare@example.com", { role: "admin" })
    const cookie = await signIn(ctx, "self@example.com")

    for (const status of ["pending", "rejected", "anything-else"]) {
      const response = await post(
        ctx,
        "/admin/update-user",
        { userId: self, data: { status } },
        { cookie }
      )
      expect(response.status, status).toBe(403)
      expect((await bodyOf(response)).code, status).toBe("ADMIN_CANNOT_BAN_SELF")
    }
    expect((await userRow(ctx, self)).status).toBe("active")
  })

  it("records the refusal in the trail as a denied rejection", async () => {
    const self = await makeUser(ctx, "trail@example.com", { role: "admin" })
    await makeUser(ctx, "spare@example.com", { role: "admin" })
    const cookie = await signIn(ctx, "trail@example.com")
    await post(
      ctx,
      "/admin/update-user",
      { userId: self, data: { status: "pending" } },
      { cookie }
    )
    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
      .where(eq(ctx.database.schema.auditLog.outcome, "denied"))
    expect(rows.map((row) => row.action)).toContain("signup.rejected")
  })

  it("still lets a colleague be set non-active, and audits it with the status", async () => {
    await makeUser(ctx, "boss@example.com", { role: "admin" })
    const other = await makeUser(ctx, "other@example.com", { role: "admin" })
    const cookie = await signIn(ctx, "boss@example.com")

    const response = await post(
      ctx,
      "/admin/update-user",
      { userId: other, data: { status: "pending" } },
      { cookie }
    )
    expect(response.status).toBe(200)
    expect((await userRow(ctx, other)).status).toBe("pending")

    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
      .where(eq(ctx.database.schema.auditLog.action, "signup.rejected"))
      .orderBy(desc(ctx.database.schema.auditLog.createdAt))
    expect(row?.outcome).toBe("success")
    expect(row?.metadata).toMatchObject({ status: "pending" })
  })

  it("refuses a column outside the allow-list, and names it", async () => {
    await makeUser(ctx, "boss@example.com", { role: "admin" })
    const target = await makeUser(ctx, "target@example.com")
    const cookie = await signIn(ctx, "boss@example.com")

    const before = await userRow(ctx, target)
    for (const data of [
      { twoFactorEnabled: true },
      { approvedAt: new Date().toISOString() },
      { approvedBy: "somebody" },
      { id: "new-id" },
      { createdAt: new Date(0).toISOString() },
      { updatedAt: new Date(0).toISOString() },
      { noSuchColumn: 1 },
      // A legal field beside an illegal one is still refused as a whole.
      { firstName: "Fine", twoFactorEnabled: true },
    ]) {
      const response = await post(
        ctx,
        "/admin/update-user",
        { userId: target, data },
        { cookie }
      )
      const key = Object.keys(data).join(",")
      expect(response.status, key).toBe(400)
      const body = await bodyOf(response)
      expect(body.code, key).toBe("UPDATE_USER_FIELD_NOT_ALLOWED")
      expect(String(body.message), key).toContain(
        Object.keys(data).find((k) => k !== "firstName")!
      )
    }
    expect(await userRow(ctx, target)).toEqual(before)
  })

  it("keeps the two in-repo callers working: the profile edit and the temporary-password flag", async () => {
    await makeUser(ctx, "boss@example.com", { role: "admin" })
    const target = await makeUser(ctx, "target@example.com")
    const cookie = await signIn(ctx, "boss@example.com")

    // `admin-actions.ts`'s `edit-profile` body, verbatim.
    const edit = await post(
      ctx,
      "/admin/update-user",
      {
        userId: target,
        data: {
          firstName: "Tar",
          lastName: "Get",
          name: "Tar Get",
          emailVerified: false,
          email: "renamed@example.com",
        },
      },
      { cookie }
    )
    expect(edit.status).toBe(200)
    const edited = await userRow(ctx, target)
    expect(edited).toMatchObject({
      firstName: "Tar",
      lastName: "Get",
      name: "Tar Get",
      emailVerified: false,
      email: "renamed@example.com",
    })

    // `admin-actions.ts`'s `temporary-password` tail.
    const flag = await post(
      ctx,
      "/admin/update-user",
      { userId: target, data: { mustChangePassword: true } },
      { cookie }
    )
    expect(flag.status).toBe(200)
    expect((await userRow(ctx, target)).mustChangePassword).toBe(true)

    // And the standing columns the guard already maps, so `admin.test.ts`'s
    // `data: { banned: true }` case is not the only ban spelling that works.
    const reactivate = await post(
      ctx,
      "/admin/update-user",
      { userId: target, data: { status: "active" } },
      { cookie }
    )
    expect(reactivate.status).toBe(200)
  })
})

describe("the console on a superuser connection", () => {
  const contexts: TestContext[] = []

  afterEach(async () => {
    while (contexts.length > 0) await contexts.pop()!.teardown()
  })

  async function start(ctx: TestContext) {
    const { logger, lines } = collectingLogger()
    const result = await runStartup({
      config: ctx.config,
      database: ctx.database,
      locking: ctx.database,
      auth: ctx.auth,
      logger,
    })
    return { result, lines }
  }

  async function isSuperuser(ctx: TestContext): Promise<boolean> {
    const [row] = await ctx.database.sql<{ rolsuper: boolean }[]>`
      select rolsuper from pg_roles where rolname = current_user`
    return row?.rolsuper === true
  }

  it("warns at start-up when the console is on and the role is a superuser", async () => {
    const ctx = await createTestContext("secrev-superuser-warn", {
      config: { admin: { database: "read-only" } },
    })
    contexts.push(ctx)
    // The shared test container connects as `postgres`; a run against a
    // properly provisioned role cannot demonstrate the warning and says so.
    if (!(await isSuperuser(ctx))) {
      console.warn("test database role is not a superuser; warning case skipped")
      return
    }

    const { result, lines } = await start(ctx)
    expect(result.steps.map((step) => step.name)).toContain("database role")
    const warning = result.warnings.find(
      (entry) => entry.code === "database.console_as_superuser"
    )
    expect(warning).toBeDefined()
    expect(warning!.message).toContain("NOSUPERUSER")
    expect(warning!.message).toContain("pg_execute_server_program")

    const logged = lines.find((line) => line.msg.includes("superuser"))
    expect(logged?.level).toBe("warn")
  })

  it("says nothing when the console is disabled", async () => {
    const ctx = await createTestContext("secrev-superuser-quiet")
    contexts.push(ctx)

    const { result, lines } = await start(ctx)
    expect(
      result.steps.find((step) => step.name === "database role")?.skipped
    ).toBe("admin.database is disabled")
    expect(result.warnings).toEqual([])
    expect(lines.find((line) => line.msg.includes("superuser"))).toBeUndefined()
  })
})

describe("what the trail records about a console statement", () => {
  let ctx: TestContext
  let cookie: string

  beforeEach(async () => {
    ctx = await createTestContext("secrev-console-audit", {
      config: {
        admin: { database: "read-only" },
        apiKeys: { enabled: true },
        auth: { requireEmailVerification: false },
      },
    })
    await makeUser(ctx, "console-admin@example.com", { role: "admin" })
    cookie = await signIn(ctx, "console-admin@example.com")
  })
  afterEach(async () => await ctx.teardown())

  async function latest(action: string) {
    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
      .where(eq(ctx.database.schema.auditLog.action, action))
      .orderBy(desc(ctx.database.schema.auditLog.createdAt))
      .limit(1)
    return row
  }

  /** The `metadata.query` the row kept, as a string. */
  function recordedQuery(row: { metadata: unknown } | undefined): string {
    const metadata = row?.metadata as { query?: unknown } | null | undefined
    return String(metadata?.query)
  }

  it("stores the statement with its literals scrubbed and its identifiers intact", async () => {
    const response = await post(
      ctx,
      "/idp/database/query",
      {
        query:
          `select id, 'hunter2-is-the-password' as pw from "user" ` +
          `where email = 'console-admin@example.com' and role = 'admin' ` +
          `and name <> $$dollar-quoted-secret$$`,
      },
      { cookie }
    )
    expect(response.status).toBe(200)

    const row = await latest("database.queried")
    const recorded = recordedQuery(row)
    expect(recorded).not.toContain("hunter2")
    expect(recorded).not.toContain("console-admin@example.com")
    expect(recorded).not.toContain("dollar-quoted-secret")
    // "Who ran what" survives: the shape of the statement is still legible.
    expect(recorded).toContain(`from "user"`)
    expect(recorded).toContain("where email =")
    // A short literal is not a secret and stays, so `status = 'active'`
    // remains readable in the trail.
    expect(recorded).toContain("'admin'")
    expect(recorded).toContain("[redacted]")
  })

  it("scrubs a failed statement too", async () => {
    const response = await post(
      ctx,
      "/idp/database/query",
      { query: `select * from nowhere where secret = 'top-secret-value'` },
      { cookie }
    )
    expect(response.status).toBe(400)
    const row = await latest("database.queried")
    expect(row?.outcome).toBe("failure")
    expect(recordedQuery(row)).not.toContain("top-secret-value")
  })

  it("names the credential: `api-key` for a key, `session` for a cookie", async () => {
    const key = await createKey(ctx, cookie)

    const viaKey = await post(
      ctx,
      "/idp/database/query",
      { query: "select 1 as one" },
      { "x-api-key": key }
    )
    expect(viaKey.status).toBe(200)
    expect((await latest("database.queried"))?.actorType).toBe("api-key")

    const viaCookie = await post(
      ctx,
      "/idp/database/query",
      { query: "select 2 as two" },
      { cookie }
    )
    expect(viaCookie.status).toBe(200)
    expect((await latest("database.queried"))?.actorType).toBe("session")

    // And an endpoint that is not the console, so the plumbing is not a
    // console-only special case.
    const target = await makeUser(ctx, "reset-me@example.com")
    const reset = await post(
      ctx,
      "/idp/reset-two-factor",
      { userId: target },
      { "x-api-key": key }
    )
    expect(reset.status).toBe(200)
    expect((await latest("twofactor.reset"))?.actorType).toBe("api-key")
  })
})

describe("the first administrator's address stays out of the log", () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestContext("secrev-first-user-log")
  })
  afterEach(async () => await ctx.teardown())

  it("logs the id and the role, not the e-mail", async () => {
    const { logger, lines, text } = collectingLogger()
    const result = await createFirstUser(
      {
        config: ctx.config,
        database: ctx.database,
        locking: ctx.database,
        auth: ctx.auth,
        audit: createAudit(ctx.database, logger),
        logger,
      },
      {
        email: "First.Operator@Example.COM",
        firstName: "Frida",
        lastName: "Operator",
        password: "a first password nobody handed over",
      }
    )
    expect(result.created).toBe(true)

    const created = lines.find((line) =>
      line.msg.includes("first user created")
    )
    expect(created).toBeDefined()
    expect(created!.fields.userId).toBe(result.userId)
    expect(text().toLowerCase()).not.toContain("first.operator@example.com")
  })
})

describe("the audit writer's address is the edge's, never the caller's", () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestContext("secrev-audit-ip")
  })
  afterEach(async () => await ctx.teardown())

  it("ignores an `ipAddress` a call site tries to pass", async () => {
    // The field is gone from `AuditEvent`, so a caller has to lie to the type
    // checker to send one — which is the point: nothing in the tree can write
    // a header value into the trail by naming it.
    const event = {
      action: "signin.success",
      outcome: "success",
      actorUserId: "u1",
      ipAddress: "203.0.113.9",
    } as unknown as AuditEvent
    await ctx.audit.record(event)

    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
    expect(row?.ipAddress ?? null).toBeNull()
  })
})
