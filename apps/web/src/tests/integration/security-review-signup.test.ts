import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createLocalAccountIssuer } from "@better-auth/core/db"
import { eq, like } from "drizzle-orm"

import { Route as NewClientRoute } from "@/routes/admin/clients/new"
import { Route as SignUpRoute } from "@/routes/signup"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { TRUST_DEVICE_PREFIX } from "@/server/auth/trusted-devices"
import { setRuntime } from "@/server/runtime"
import { secretFromTotpUri, totpCode } from "../fixtures/totp"
import {
  asRuntime,
  authRequest,
  createTestContext,
  sessionCookie,
} from "./harness"
import type { TestContext } from "./harness"

/**
 * Security review 2026-09, work stream S5: sign-up enumeration,
 * the consent default for admin-registered clients and the hard
 * ceiling on a trusted browser.
 *
 * The sign-up cases drive the real `/signup` form POST through
 * `Route.options.server.handlers`, the way `account-revocation.test.ts`
 * does, because the finding *is* the shape of that response: a taken address
 * used to come back as a 303 to `/signup?error=…` while a new one went to
 * `/verify-email`, and no assertion on the endpoint underneath could see
 * that. `setRuntime(asRuntime(context))` is the seam.
 */

const ISSUER = "http://localhost:3000"
const PASSWORD = "correct horse battery staple"
const DAY = 24 * 60 * 60 * 1000

type Handler = (input: { request: Request }) => Promise<Response>

function postHandler(route: { options: { server?: unknown } }): Handler {
  const handlers = (
    route.options.server as { handlers?: { POST?: unknown } } | undefined
  )?.handlers
  const declared = handlers?.POST
  if (typeof declared !== "function") {
    throw new Error("the route has no POST handler in record form")
  }
  return declared as Handler
}

/** A browser's form post: same-origin, form-encoded, optionally signed in. */
async function postForm(
  route: { options: { server?: unknown } },
  path: string,
  fields: Record<string, string>,
  cookie?: string
): Promise<Response> {
  return postHandler(route)({
    request: new Request(`${ISSUER}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        "sec-fetch-site": "same-origin",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(fields),
    }),
  })
}

/** Everything about a redirect a caller could compare across two attempts. */
function shapeOf(response: Response) {
  return {
    status: response.status,
    location: response.headers.get("location"),
    cookies: response.headers.getSetCookie(),
  }
}

const EMAIL_ON = {
  resend: { apiKey: "re_test" },
  from: "IdP <idp@example.com>",
}

describe("sign-up enumeration with e-mail on", () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await createTestContext("secrev-signup-email", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        email: EMAIL_ON,
      },
    })
    setRuntime(asRuntime(ctx))
  }, 120_000)
  afterAll(async () => await ctx.teardown())
  beforeEach(() => ctx.mailer.captured.clear())

  async function signUp(email: string): Promise<Response> {
    return postForm(SignUpRoute, "/signup", {
      email,
      password: PASSWORD,
      firstName: "Dee",
      lastName: "Duplicate",
    })
  }

  it("answers a taken address exactly as it answers a new one", async () => {
    const email = `taken-${Date.now()}@example.com`

    const first = await signUp(email)
    expect(first.status).toBe(303)
    expect(first.headers.get("location")).toBe(
      `/verify-email?sent=1&email=${encodeURIComponent(email)}`
    )

    const second = await signUp(email)
    expect(shapeOf(second)).toEqual(shapeOf(first))
    // Nothing in the answer names the refusal.
    expect(second.headers.get("location")).not.toContain("error")
  })

  it("tells the existing owner, and nobody else, that someone tried", async () => {
    const email = `owner-${Date.now()}@example.com`
    await signUp(email)
    ctx.mailer.captured.clear()

    await signUp(email)

    const notices = ctx.mailer.captured.messages.filter(
      (message) => message.template === "signup-existing-account"
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]!.to).toBe(email)
    expect(notices[0]!.subject).toContain("Test IdP")
    // The way back in for an owner who forgot they had an account; no link
    // into the account itself.
    expect(notices[0]!.text).toContain("http://localhost:3000/forgot-password")
    // And no second verification message for an address that is not new.
    expect(ctx.mailer.captured.last("verify-email")).toBeUndefined()
  })

  it("puts the attempt on the audit trail without an account of its own", async () => {
    const email = `trail-${Date.now()}@example.com`
    await signUp(email)
    await signUp(email)

    const rows = await ctx.database.db
      .select({
        outcome: ctx.database.schema.auditLog.outcome,
        actorType: ctx.database.schema.auditLog.actorType,
        metadata: ctx.database.schema.auditLog.metadata,
      })
      .from(ctx.database.schema.auditLog)
      .where(eq(ctx.database.schema.auditLog.action, "signup.duplicate"))
    const mine = rows.filter(
      (row) => (row.metadata as { email?: string } | null)?.email === email
    )
    expect(mine).toHaveLength(1)
    expect(mine[0]!.outcome).toBe("denied")
    expect(mine[0]!.actorType).toBe("anonymous")

    // Exactly one account for the address, whatever the second attempt did.
    const users = await ctx.database.db
      .select({ id: ctx.database.schema.user.id })
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.email, email))
    expect(users).toHaveLength(1)
  })

  it("keeps every other refusal as a refusal", async () => {
    // A wrong-shaped password is the caller's own mistake and says so; only
    // the duplicate is hidden, because only the duplicate leaks a fact.
    const response = await postForm(SignUpRoute, "/signup", {
      email: `short-${Date.now()}@example.com`,
      password: "short",
    })
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toContain("/signup?error=")
  })
})

describe("sign-up enumeration with approval on", () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await createTestContext("secrev-signup-approval", {
      config: {
        signUp: { enabled: true, requireApproval: true },
        email: EMAIL_ON,
      },
    })
    setRuntime(asRuntime(ctx))
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  it("lands both on the pending-approval page", async () => {
    const email = `approval-${Date.now()}@example.com`
    const fields = { email, password: PASSWORD }

    const first = await postForm(SignUpRoute, "/signup", fields)
    expect(first.headers.get("location")).toBe("/pending-approval")

    const second = await postForm(SignUpRoute, "/signup", fields)
    expect(shapeOf(second)).toEqual(shapeOf(first))
    expect(ctx.mailer.captured.last("signup-existing-account")?.to).toBe(email)
  })
})

describe("sign-up enumeration in degraded mode", () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await createTestContext("secrev-signup-degraded", {
      config: { signUp: { enabled: true, requireApproval: false } },
    })
    setRuntime(asRuntime(ctx))
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  it("refuses, because there is no owner to tell", async () => {
    // Better Auth's generic answer would have landed the duplicate on
    // `/login?notice=account_created` — where the sign-in then fails and
    // there is no reset link to send. The spec accepts the enumeration here.
    expect(ctx.config.emailEnabled).toBe(false)
    const email = `degraded-${Date.now()}@example.com`
    const fields = { email, password: PASSWORD }

    const first = await postForm(SignUpRoute, "/signup", fields)
    expect(first.headers.get("location")).toBe("/login?notice=account_created")

    const second = await postForm(SignUpRoute, "/signup", fields)
    expect(second.status).toBe(303)
    expect(second.headers.get("location")).toBe("/signup?error=signup_failed")
    expect(ctx.mailer.captured.messages).toHaveLength(0)
  })
})

describe("the owner's notice is throttled", () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await createTestContext("secrev-signup-throttle", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        email: EMAIL_ON,
        // The throttle is under the same switch as every other bucket, and
        // the harness turns that off. Three posts stay under Better Auth's
        // own five-per-window on `/sign-up/email`.
        rateLimit: { enabled: true },
      },
    })
    setRuntime(asRuntime(ctx))
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  it("sends one notice an hour per address, and answers the same regardless", async () => {
    const email = `bombed-${Date.now()}@example.com`
    const fields = { email, password: PASSWORD }
    const first = await postForm(SignUpRoute, "/signup", fields)
    ctx.mailer.captured.clear()

    const second = await postForm(SignUpRoute, "/signup", fields)
    const third = await postForm(SignUpRoute, "/signup", fields)
    expect(shapeOf(second)).toEqual(shapeOf(first))
    expect(shapeOf(third)).toEqual(shapeOf(first))
    expect(
      ctx.mailer.captured.messages.filter(
        (message) => message.template === "signup-existing-account"
      )
    ).toHaveLength(1)
  })
})

/**
 * The create form's consent default, end to end: what the page
 * posts with its checkboxes untouched is a client that asks. `client-rules`'
 * unit test pins the value; this pins that the handler turns it into the row
 * an administrator would then see in the "Consent required" column.
 */
describe("a client registered from the form asks for consent", () => {
  let ctx: TestContext
  let cookie: string

  beforeAll(async () => {
    ctx = await createTestContext("secrev-consent-default", {
      config: {
        admin: { adminRoles: ["admin"] },
        auth: { requireEmailVerification: false },
      },
    })
    setRuntime(asRuntime(ctx))

    const inner = await ctx.auth.$context
    const admin = await createUserWithoutRequest(
      inner,
      {
        email: "secrev-admin@example.com",
        name: "Reviewer",
        emailVerified: true,
        role: "admin",
        status: "active",
      },
      { method: "admin" }
    )
    await inner.internalAdapter.createAccount({
      userId: admin.id,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: admin.id,
      password: await inner.password.hash(PASSWORD),
    })
    const signedIn = await ctx.auth.handler(
      authRequest("/sign-in/email", {
        json: { email: "secrev-admin@example.com", password: PASSWORD },
      })
    )
    cookie = sessionCookie(signedIn)!
    expect(cookie, "the administrator must be able to sign in").toBeTruthy()
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  it("stores skipConsent: false for the page's untouched defaults", async () => {
    // What `/admin/clients/new` posts when the administrator fills in the
    // three required fields and touches nothing else: `requireConsent=on`
    // is the ticked default, `enableEndSession` is absent because it is not.
    const response = await postForm(
      NewClientRoute,
      "/admin/clients/new",
      {
        clientId: "asks-by-default",
        name: "Asks By Default",
        type: "spa",
        redirectUris: "https://app.example.com/callback",
        scopes: "openid",
        requireConsent: "on",
      },
      cookie
    )
    expect(response.status, await response.text()).toBe(303)
    expect(response.headers.get("location")).toBe(
      "/admin/clients?notice=clientCreatedPublic"
    )

    const [row] = await ctx.database.db
      .select({ skipConsent: ctx.database.schema.oauthClient.skipConsent })
      .from(ctx.database.schema.oauthClient)
      .where(eq(ctx.database.schema.oauthClient.clientId, "asks-by-default"))
    expect(row?.skipConsent).toBe(false)
  })

  it("still lets an administrator untick it", async () => {
    const response = await postForm(
      NewClientRoute,
      "/admin/clients/new",
      {
        clientId: "first-party",
        name: "First Party",
        type: "spa",
        redirectUris: "https://app.example.com/callback",
        scopes: "openid",
      },
      cookie
    )
    expect(response.status, await response.text()).toBe(303)
    const [row] = await ctx.database.db
      .select({ skipConsent: ctx.database.schema.oauthClient.skipConsent })
      .from(ctx.database.schema.oauthClient)
      .where(eq(ctx.database.schema.oauthClient.clientId, "first-party"))
    expect(row?.skipConsent).toBe(true)
  })
})

/**
 * The hard ceiling on a trusted browser, driven through Better
 * Auth's own re-mint.
 *
 * The unit file asserts the two database hooks in isolation; this signs in
 * with a real trust cookie, lets the plugin delete and re-create the row, and
 * reads what landed. It runs only once the hooks are wired into
 * `buildDatabaseHooks` (`verification: trustedDeviceVerificationHooks(…)`),
 * and skips — visibly — until then, because the harness builds the instance
 * from `instance.ts` and there is no seam to add a database hook afterwards.
 */
describe("a trusted browser has a hard ceiling", () => {
  const EMAIL = "secrev-trust@example.com"
  let ctx: TestContext
  let wired = false

  beforeAll(async () => {
    ctx = await createTestContext("secrev-trust-ceiling", {
      config: {
        signUp: { enabled: true, requireApproval: false },
        auth: { requireEmailVerification: false },
        twoFactor: { enabled: true, trustDeviceDays: 30 },
      },
    })
    const inner = await ctx.auth.$context
    wired = Boolean(inner.options.databaseHooks?.verification?.create?.before)
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  /** The `trust_device` cookie pair out of a response, if it set one. */
  function trustCookie(response: Response): string | undefined {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";")
      if (pair?.includes("trust_device") && !/=\s*$/.test(pair)) return pair
    }
    return undefined
  }

  async function signIn(extraCookie?: string): Promise<Response> {
    return ctx.auth.handler(
      authRequest("/sign-in/email", {
        ...(extraCookie ? { headers: { cookie: extraCookie } } : {}),
        json: { email: EMAIL, password: PASSWORD },
      })
    )
  }

  async function trustRow() {
    const { verification } = ctx.database.schema
    const rows = await ctx.database.db
      .select({
        id: verification.id,
        createdAt: verification.createdAt,
        expiresAt: verification.expiresAt,
      })
      .from(verification)
      .where(like(verification.identifier, `${TRUST_DEVICE_PREFIX}%`))
    expect(rows, "exactly one trust row").toHaveLength(1)
    return rows[0]!
  }

  it("caps a rotation at three windows from the first trust, then asks again", async ({
    skip,
  }) => {
    if (!wired) skip()

    // Register, enroll, and answer the challenge with "trust this device".
    const created = await ctx.auth.handler(
      authRequest("/sign-up/email", {
        json: { email: EMAIL, password: PASSWORD, name: "Trusting" },
      })
    )
    expect(created.status).toBe(200)
    const session = sessionCookie(await signIn())!
    const enabled = await ctx.auth.handler(
      authRequest("/two-factor/enable", {
        headers: { cookie: session },
        json: { password: PASSWORD },
      })
    )
    const secret = secretFromTotpUri(
      ((await enabled.json()) as { totpURI: string }).totpURI
    )
    await ctx.auth.handler(
      authRequest("/two-factor/verify-totp", {
        headers: { cookie: session },
        json: { code: totpCode(secret) },
      })
    )
    const challenged = await signIn()
    const challenge = challenged.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ")
    const trusted = await ctx.auth.handler(
      authRequest("/two-factor/verify-totp", {
        headers: { cookie: challenge },
        json: { code: totpCode(secret), trustDevice: true },
      })
    )
    expect(trusted.status).toBe(200)
    const cookie = trustCookie(trusted)
    expect(cookie, "the challenge should hand back a trust cookie").toBeTruthy()

    // Eighty-nine days later, by the row's own account.
    const { verification } = ctx.database.schema
    const first = new Date(Date.now() - 89 * DAY)
    await ctx.database.db
      .update(verification)
      .set({ createdAt: first })
      .where(eq(verification.id, (await trustRow()).id))

    // The re-mint: a sign-in that skips the factor and rotates the row.
    const rotated = await signIn(cookie)
    expect(rotated.status).toBe(200)
    expect(sessionCookie(rotated), "trusted: no challenge").toBeTruthy()
    const next = trustCookie(rotated)
    expect(next, "the row rotated").toBeTruthy()

    const row = await trustRow()
    // The anchor survived the rotation, and the new expiry is one day out
    // rather than thirty.
    expect(Math.abs(row.createdAt.getTime() - first.getTime())).toBeLessThan(
      1000
    )
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(
      first.getTime() + 90 * DAY
    )
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now())

    // Past the ceiling the row is dead however fresh its last rotation, and
    // the browser meets the second factor again.
    await ctx.database.db
      .update(verification)
      .set({ createdAt: new Date(Date.now() - 91 * DAY) })
      .where(eq(verification.id, row.id))
    const again = await signIn(next)
    // Still within the plugin's own expiry, so this rotation goes through —
    // and lands a row whose capped expiry is already in the past.
    expect(again.status).toBe(200)
    const dead = await trustRow()
    expect(dead.expiresAt.getTime()).toBeLessThan(Date.now())

    const asked = await signIn(trustCookie(again))
    expect(
      ((await asked.clone().json()) as { twoFactorRedirect?: boolean })
        .twoFactorRedirect
    ).toBe(true)
  })
})
