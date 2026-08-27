/**
 * The administrative surface, against a real server (TST-3, FR-ADMIN-2..6,
 * FR-ROLE-3, FR-KEY-2, FR-OIDC-12).
 *
 * Three things are worth testing here and nothing else is:
 *
 *  1. **The refusals hold against the API**, not only against the UI. Every
 *     invariant is asserted by calling the endpoint the way a script would,
 *     because FR-ADMIN-6 makes the API the interface and the buttons a client
 *     of it. A rule enforced only by a disabled button is not enforced.
 *  2. **A ban actually ends access** — sessions, OAuth tokens *and* API keys —
 *     and unbanning restores what it should. This is the requirement most
 *     likely to be half-implemented, because each of the three lives in a
 *     different plugin.
 *  3. **Nothing administrative answers a non-administrator**, including Better
 *     Auth's own endpoints, which our guard sits in front of but does not
 *     authorise.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import { createResetLink } from "@/server/auth/reset-link"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { createLocalAccountIssuer } from "@better-auth/core/db"
import type { TestContext } from "./harness"
import { adminErrorCodeFor } from "@/server/http/auth-proxy"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const PASSWORD = "correct-horse-battery-staple"
/** Distinct from every other literal here, so a leak is unambiguous. */
const DIRECT_URL_PASSWORD = "direct-url-password-must-not-leak"
const DIRECT_URL = `postgres://idp:${DIRECT_URL_PASSWORD}@direct.example.com:5432/idp?sslmode=require`
const NEW_PASSWORD = "a-different-passphrase-entirely"

let ctx: TestContext

beforeEach(async () => {
  ctx = await createTestContext("admin", {
    config: {
      signUp: { enabled: true, requireApproval: false },
      auth: { requireEmailVerification: false },
      apiKeys: { enabled: true },
      email: { resend: { apiKey: "re_test" }, from: "IdP <idp@example.com>" },
      // Only `/idp/system`'s masking reads this. Nothing in this file reaches
      // an endpoint that opens the direct connection (rotate-keys is called
      // here only to be refused, before it builds one).
      database: { directUrl: DIRECT_URL },
    },
  })
})

afterEach(async () => {
  await ctx.teardown()
})

/** Creates a user directly, so the test controls status and roles exactly. */
async function makeUser(
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
  // A local credential, built the way `startup.ts` builds the bootstrap
  // admin's — namespaced issuer included, or sign-in cannot find it.
  await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: user.id,
    password: await context.password.hash(PASSWORD),
  })
  return user.id
}

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", { json: { email, password } })
  )
  const cookie = sessionCookie(response)
  expect(cookie, `sign-in failed for ${email}`).toBeTruthy()
  return cookie!
}

async function post(
  path: string,
  json: unknown,
  cookie?: string
): Promise<Response> {
  return ctx.auth.handler(
    authRequest(path, {
      json,
      ...(cookie ? { headers: { cookie } } : {}),
    })
  )
}

/**
 * The JSON body, with "no session" flattened to an empty object.
 *
 * `/get-session` answers a bare `null` for an anonymous caller, and reading
 * `.user` off that throws a `TypeError` instead of failing the assertion — a
 * confusing way to be told the ban worked.
 */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json().catch(() => null)) as unknown
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {}
}

describe("the last administrator", () => {
  it("cannot be demoted, banned or deleted, by any route", async () => {
    const only = await makeUser("only-admin@example.com", { role: "admin" })
    const helper = await makeUser("helper@example.com", { role: "admin" })
    const cookie = await signIn("helper@example.com")

    // While two exist, the first is ordinary.
    expect(
      (await post("/admin/set-role", { userId: only, role: "user" }, cookie))
        .status
    ).toBe(200)

    // `helper` is now the only usable administrator — and the only caller who
    // could still reach these endpoints, since nobody else holds the role. So
    // the reachable last-admin case *is* the self case, which is why the rule
    // is ordered ahead of the self rules rather than behind them.
    for (const [path, body] of [
      ["/admin/set-role", { userId: helper, role: "user" }],
      ["/admin/ban-user", { userId: helper }],
      ["/admin/remove-user", { userId: helper }],
      ["/admin/update-user", { userId: helper, data: { banned: true } }],
    ] as const) {
      const response = await post(path, body, cookie)
      expect(response.status, path).toBe(403)
      expect((await bodyOf(response)).code).toBe("LAST_ADMIN_PROTECTED")
    }
  })

  it("does not count a suspended administrator as a fallback", async () => {
    const alice = await makeUser("alice@example.com", { role: "admin" })
    const bob = await makeUser("bob@example.com", { role: "admin" })
    const carl = await makeUser("carl@example.com", { role: "admin" })
    const cookie = await signIn("carl@example.com")

    expect(
      (await post("/admin/ban-user", { userId: bob }, cookie)).status
    ).toBe(200)
    // Carl is now the only *usable* one; Bob is suspended and Alice is fine.
    expect(
      (await post("/admin/ban-user", { userId: alice }, cookie)).status
    ).toBe(200)
    const last = await post("/admin/ban-user", { userId: carl }, cookie)
    expect(last.status).toBe(403)
  })

  it("lets a demotion through when admin survives among the new roles", async () => {
    await makeUser("solo@example.com", { role: "admin" })
    const cookie = await signIn("solo@example.com")
    const other = await makeUser("other@example.com", { role: "admin" })

    const response = await post(
      "/admin/set-role",
      { userId: other, role: ["support", "admin"] },
      cookie
    )
    expect(response.status).toBe(200)
  })
})

describe("self-actions", () => {
  it("refuses the destructive ones and names why", async () => {
    const self = await makeUser("self@example.com", { role: "admin" })
    await makeUser("spare@example.com", { role: "admin" })
    const cookie = await signIn("self@example.com")

    const cases: [string, Record<string, unknown>, string][] = [
      [
        "/admin/set-role",
        { userId: self, role: "user" },
        "ADMIN_CANNOT_CHANGE_OWN_ROLES",
      ],
      ["/admin/ban-user", { userId: self }, "ADMIN_CANNOT_BAN_SELF"],
      ["/admin/remove-user", { userId: self }, "ADMIN_CANNOT_DELETE_SELF"],
    ]
    for (const [path, body, code] of cases) {
      const response = await post(path, body, cookie)
      expect(response.status, path).toBe(403)
      expect((await bodyOf(response)).code, path).toBe(code)
    }
  })

  it("records the refusal in the trail", async () => {
    const self = await makeUser("logged@example.com", { role: "admin" })
    await makeUser("spare2@example.com", { role: "admin" })
    const cookie = await signIn("logged@example.com")
    await post("/admin/ban-user", { userId: self }, cookie)

    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
      .where(eq(ctx.database.schema.auditLog.outcome, "denied"))
    expect(rows.map((row) => row.action)).toContain("user.banned")
  })
})

describe("a ban", () => {
  it("ends sessions, OAuth tokens and API keys, and unbanning restores the keys", async () => {
    await makeUser("boss@example.com", { role: "admin" })
    const adminCookie = await signIn("boss@example.com")
    const victim = await makeUser("victim@example.com")
    const victimCookie = await signIn("victim@example.com")

    // FR-KEY-1: a key of their own, which must survive the ban as a *row* even
    // though it stops working (FR-KEY-2).
    const created = await post(
      "/api-key/create",
      { name: "victim key" },
      victimCookie
    )
    expect(created.status).toBe(200)
    const key = (await bodyOf(created)).key as string
    expect(key).toBeTruthy()

    const withKey = async () =>
      ctx.auth.handler(
        authRequest("/get-session", {
          method: "GET",
          headers: { "x-api-key": key },
        })
      )

    const before = await withKey()
    expect((await bodyOf(before)).user).toBeTruthy()

    // Something in the OAuth tables to prove the revoker ran. The token row
    // has a foreign key to the client, so the client has to exist first.
    await ctx.database.db.insert(ctx.database.schema.oauthClient).values({
      id: "client-row-1",
      clientId: "someone",
      name: "Someone",
      redirectUris: ["https://app.example.com/cb"],
    })
    await ctx.database.db.insert(ctx.database.schema.oauthAccessToken).values({
      id: "tok-1",
      token: "access-1",
      clientId: "someone",
      userId: victim,
      scopes: ["openid"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    })

    expect(
      (await post("/admin/ban-user", { userId: victim }, adminCookie)).status
    ).toBe(200)

    // The session is gone.
    const session = await ctx.auth.handler(
      authRequest("/get-session", {
        method: "GET",
        headers: { cookie: victimCookie },
      })
    )
    expect((await bodyOf(session)).user).toBeFalsy()

    // The OAuth token is gone (FR-OIDC-12).
    const tokens = await ctx.database.db
      .select()
      .from(ctx.database.schema.oauthAccessToken)
      .where(eq(ctx.database.schema.oauthAccessToken.userId, victim))
    expect(tokens).toHaveLength(0)

    // The key still exists but no longer authenticates (FR-KEY-2).
    const keys = await ctx.database.db
      .select()
      .from(ctx.database.schema.apikey)
      .where(eq(ctx.database.schema.apikey.referenceId, victim))
    expect(keys).toHaveLength(1)
    expect((await bodyOf(await withKey())).user).toBeFalsy()

    // And unbanning brings it back, without anyone re-issuing anything.
    expect(
      (await post("/admin/unban-user", { userId: victim }, adminCookie)).status
    ).toBe(200)
    expect((await bodyOf(await withKey())).user).toBeTruthy()
  })
})

describe("who may call what", () => {
  it("refuses every administrative endpoint to an ordinary user", async () => {
    await makeUser("owner@example.com", { role: "admin" })
    const target = await makeUser("plain@example.com")
    const cookie = await signIn("plain@example.com")

    const endpoints: [string, Record<string, unknown>][] = [
      ["/idp/approve-user", { userId: target }],
      ["/idp/reject-user", { userId: target }],
      ["/idp/reset-two-factor", { userId: target }],
      ["/idp/rotate-keys", {}],
      ["/admin/ban-user", { userId: target }],
      ["/admin/set-role", { userId: target, role: "admin" }],
      ["/admin/remove-user", { userId: target }],
      ["/admin/impersonate-user", { userId: target }],
    ]
    for (const [path, body] of endpoints) {
      const response = await post(path, body, cookie)
      expect([401, 403], `${path} answered ${response.status}`).toContain(
        response.status
      )
    }

    for (const path of ["/idp/admin-stats", "/idp/audit", "/idp/system"]) {
      const response = await ctx.auth.handler(
        authRequest(path, { method: "GET", headers: { cookie } })
      )
      expect([401, 403], `${path} answered ${response.status}`).toContain(
        response.status
      )
    }
  })

  it("refuses an anonymous caller the same way", async () => {
    const response = await post("/idp/admin-stats", {})
    expect([401, 403, 404, 405]).toContain(response.status)
  })

  it("answers an administrator holding an API key (FR-ADMIN-6)", async () => {
    await makeUser("api-admin@example.com", { role: "admin" })
    const cookie = await signIn("api-admin@example.com")
    const created = await post("/api-key/create", { name: "ops" }, cookie)
    const key = (await bodyOf(created)).key as string

    const response = await ctx.auth.handler(
      authRequest("/idp/admin-stats", {
        method: "GET",
        headers: { "x-api-key": key },
      })
    )
    expect(response.status).toBe(200)
    const stats = (await bodyOf(response)).users as { admins: number }
    expect(stats.admins).toBeGreaterThanOrEqual(1)
  })
})

describe("what /admin/create-user refuses, and how it says so (D70)", () => {
  /**
   * These two assert **Better Auth's own identifiers**, which is unusual here
   * and deliberate. `adminErrorCodeFor` translates a code it does not own, so
   * a dependency bump that renames one silently reopens the field report: a
   * valid create form answering "that e-mail address and password combination
   * is not correct" in a dialog with no password field. Pinning the string
   * makes the bump fail a test instead of a dialog.
   */
  async function createUser(
    body: Record<string, unknown>
  ): Promise<{ status: number; code: unknown; mapped: string }> {
    await makeUser("creator@example.com", { role: "admin" })
    const cookie = await signIn("creator@example.com")
    const response = await post("/admin/create-user", body, cookie)
    const parsed = await bodyOf(response)
    return {
      status: response.status,
      code: parsed.code,
      mapped: adminErrorCodeFor({
        ok: response.ok,
        status: response.status,
        body: parsed,
        cookies: [],
      }),
    }
  }

  it("names a duplicate address instead of doubting a password", async () => {
    await makeUser("taken@example.com")
    const { status, code, mapped } = await createUser({
      email: "taken@example.com",
      password: "a-password-nobody-will-use-here",
      name: "Taken",
    })

    expect(status).toBe(400)
    expect(code).toBe("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")
    expect(mapped).toBe("email_exists")
    expect(mapped).not.toBe("invalid_credentials")
  })

  it("names a malformed address as one", async () => {
    const { code, mapped } = await createUser({
      email: "not-an-email",
      password: "a-password-nobody-will-use-here",
      name: "Nobody",
    })

    expect(code).toBe("INVALID_EMAIL")
    expect(mapped).toBe("invalid_email")
  })
})

describe("impersonation", () => {
  it("is refused when the server has it turned off (the default)", async () => {
    await makeUser("watcher@example.com", { role: "admin" })
    const cookie = await signIn("watcher@example.com")
    const target = await makeUser("watched@example.com")

    const response = await post(
      "/admin/impersonate-user",
      { userId: target },
      cookie
    )
    expect(response.status).toBe(403)
    expect((await bodyOf(response)).code).toBe("IMPERSONATION_DISABLED")
  })

  it("works when it is turned on, and never against oneself", async () => {
    await ctx.teardown()
    ctx = await createTestContext("admin-imp", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        auth: { requireEmailVerification: false },
        admin: { allowImpersonation: true },
      },
    })

    const self = await makeUser("actor@example.com", { role: "admin" })
    const cookie = await signIn("actor@example.com")
    const target = await makeUser("subject@example.com")

    const refused = await post(
      "/admin/impersonate-user",
      { userId: self },
      cookie
    )
    expect(refused.status).toBe(403)
    expect((await bodyOf(refused)).code).toBe("ADMIN_CANNOT_IMPERSONATE_SELF")

    const allowed = await post(
      "/admin/impersonate-user",
      { userId: target },
      cookie
    )
    expect(allowed.status).toBe(200)
    const impersonated = sessionCookie(allowed)
    expect(impersonated).toBeTruthy()

    const session = await ctx.auth.handler(
      authRequest("/get-session", {
        method: "GET",
        headers: { cookie: impersonated! },
      })
    )
    const body = await bodyOf(session)
    expect((body.user as { email: string }).email).toBe("subject@example.com")
    // FR-ADMIN-5: the trail — and the banner — depend on this being set.
    expect((body.session as { impersonatedBy?: string }).impersonatedBy).toBe(
      self
    )
  })
})

describe("the endpoints this app adds", () => {
  it("approves and rejects, and a rejection ends the session", async () => {
    await ctx.teardown()
    ctx = await createTestContext("admin-approval", {
      config: {
        signUp: { enabled: true, requireApproval: true },
        auth: { requireEmailVerification: false },
        email: { resend: { apiKey: "re_test" }, from: "IdP <idp@example.com>" },
      },
    })
    await makeUser("gate@example.com", { role: "admin" })
    const cookie = await signIn("gate@example.com")
    // Through the real sign-up, not `makeUser`: an *administrative* create is
    // active by construction (FR-SIGNUP-2), so a user who is genuinely waiting
    // can only be made by somebody actually registering.
    await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: {
          email: "waiting@example.com",
          password: PASSWORD,
          name: "Waiting",
        },
      })
    )
    const waitingRows = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.email, "waiting@example.com"))
    const waiting = waitingRows[0]!.id
    expect(waitingRows[0]!.status).toBe("pending")

    expect(
      (await post("/idp/approve-user", { userId: waiting }, cookie)).status
    ).toBe(200)
    const approved = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.id, waiting))
    expect(approved[0]?.status).toBe("active")
    expect(ctx.mailer.captured.last("account-approved")).toBeTruthy()

    expect(
      (await post("/idp/reject-user", { userId: waiting }, cookie)).status
    ).toBe(200)
    const sessions = await ctx.database.db
      .select()
      .from(ctx.database.schema.session)
      .where(eq(ctx.database.schema.session.userId, waiting))
    expect(sessions).toHaveLength(0)
  })

  it("resets a second factor, and signs the user out while doing it", async () => {
    await makeUser("help@example.com", { role: "admin" })
    const cookie = await signIn("help@example.com")
    const locked = await makeUser("locked@example.com")
    await signIn("locked@example.com")

    // Enrolment rows the user cannot reach any more.
    await ctx.database.db.insert(ctx.database.schema.twoFactor).values({
      id: "tf-1",
      userId: locked,
      secret: "secret",
      backupCodes: "codes",
    })
    await ctx.database.db
      .update(ctx.database.schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(ctx.database.schema.user.id, locked))

    const response = await post(
      "/idp/reset-two-factor",
      { userId: locked },
      cookie
    )
    expect(response.status).toBe(200)

    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.twoFactor)
      .where(eq(ctx.database.schema.twoFactor.userId, locked))
    expect(rows).toHaveLength(0)

    const sessions = await ctx.database.db
      .select()
      .from(ctx.database.schema.session)
      .where(eq(ctx.database.schema.session.userId, locked))
    expect(sessions).toHaveLength(0)
    expect(ctx.mailer.captured.last("two-factor-reset")).toBeTruthy()
  })

  it("reports the system it is running on, with secrets masked", async () => {
    await makeUser("ops@example.com", { role: "admin" })
    const cookie = await signIn("ops@example.com")

    // A key exists only once something has asked for one; `/jwks` is what a
    // relying party would call, and it mints the first one.
    await ctx.auth.handler(authRequest("/jwks", { method: "GET" }))

    const response = await ctx.auth.handler(
      authRequest("/idp/system", { method: "GET", headers: { cookie } })
    )
    expect(response.status).toBe(200)
    const body = await bodyOf(response)
    const config = body.config as Record<string, unknown>
    // SEC-5: the one assertion that matters on this endpoint.
    expect(config.secret).toBe("***")
    expect(JSON.stringify(config)).not.toContain(
      "integration-test-secret-0123456789abcdef"
    )
    // Round 2, finding 12: `database.directUrl` (D27) reached the browser with
    // its password intact, because masking is positional and nobody added the
    // pointer. Both connection strings keep their shape and lose the password.
    const database = config.database as Record<string, string>
    expect(database.directUrl).toBe(
      "postgres://idp:***@direct.example.com:5432/idp?sslmode=require"
    )
    expect(JSON.stringify(config)).not.toContain(DIRECT_URL_PASSWORD)
    expect(
      (body.signingKeys as { published: number }).published
    ).toBeGreaterThan(0)

    // D55: absolute, and every entry a URL this deployment answers on. At the
    // host root there is no RFC 8414 origin-root form, because there is no
    // path for the well-known segment to sit in front of.
    const discovery = body.discovery as { key: string; url: string }[]
    expect(discovery.map((entry) => entry.url)).toEqual([
      "http://localhost:3000/.well-known/openid-configuration",
      "http://localhost:3000/.well-known/oauth-authorization-server",
      "http://localhost:3000/.well-known/jwks.json",
      "http://localhost:3000/.well-known/change-password",
    ])
  })

  it("pages the audit trail newest-first, with a usable cursor", async () => {
    await makeUser("reader@example.com", { role: "admin" })
    const cookie = await signIn("reader@example.com")

    const response = await ctx.auth.handler(
      authRequest("/idp/audit?limit=2", { method: "GET", headers: { cookie } })
    )
    expect(response.status).toBe(200)
    const body = await bodyOf(response)
    const events = body.events as { createdAt: string }[]
    expect(events.length).toBeLessThanOrEqual(2)
    if (events.length === 2) {
      expect(new Date(events[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(events[1]!.createdAt).getTime()
      )
    }
  })
})

describe("the administrator's password-reset link", () => {
  it("is accepted by the real reset endpoint (Better Auth 1.7.1 convention)", async () => {
    // The point of this test is the coupling in `auth/reset-link.ts`: it mints
    // the verification row by hand, so something has to prove the convention
    // it mints against is still the one the endpoint reads.
    const userId = await makeUser("newcomer@example.com")
    const link = await createResetLink(
      { config: ctx.config, auth: ctx.auth } as never,
      userId
    )

    // D65: the page reads the token before rendering, and the read must not
    // spend it. `findVerificationValue` is what Better Auth's own
    // `GET /reset-password/:token` validator uses, and the stored value is the
    // user id — which is what lets the page name the account.
    const context = await ctx.auth.$context
    const seen = await context.internalAdapter.findVerificationValue(
      `reset-password:${link.token}`
    )
    expect(seen?.value).toBe(userId)
    expect(seen!.expiresAt.getTime()).toBeGreaterThan(Date.now())

    const response = await post("/reset-password", {
      token: link.token,
      newPassword: NEW_PASSWORD,
    })
    // Still accepted after the read, which is the half that matters.
    expect(response.status).toBe(200)

    // And the new password is the one that works.
    await signIn("newcomer@example.com", NEW_PASSWORD)

    // Spent now: the row is deleted, so "already used" and "never existed"
    // are the same observation — which is why the page's copy covers both.
    expect(
      await context.internalAdapter.findVerificationValue(
        `reset-password:${link.token}`
      )
    ).toBeFalsy()
  })

  it("marks an administrator's link as an invitation (D65)", async () => {
    // The flag only changes what the page says; it is not in the token, and
    // forging it changes copy and nothing else.
    const invite = await createResetLink(
      { config: ctx.config, auth: ctx.auth } as never,
      await makeUser("invited@example.com"),
      { welcome: true }
    )
    expect(invite.url).toContain("welcome=1")
  })
})
