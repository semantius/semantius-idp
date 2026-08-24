/**
 * Social sign-in against a real provider (FR-SOC-2/3/4, D24, TST-7).
 *
 * The whole flow runs: `/sign-in/social` produces an authorization URL, the
 * mock provider bounces back with a code, Better Auth exchanges it and the
 * callback lands. What is asserted is what *this* IdP adds on top — the
 * per-provider domain allow-list, the profile-sync switch, and the refusal
 * when a provider claims an address that already belongs to someone else.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import type { TestContext } from "./harness"
import { createTestContext } from "./harness"
import { startMockOidcProvider } from "../fixtures/mock-oidc-provider"
import type { MockOidcProvider } from "../fixtures/mock-oidc-provider"

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

let provider: MockOidcProvider
let restoreFetch: () => void

beforeAll(async () => {
  provider = await startMockOidcProvider()
  restoreFetch = provider.interceptTokenEndpoint(GOOGLE_TOKEN_URL)
})

afterAll(async () => {
  restoreFetch()
  await provider.stop()
})

interface SocialContextOptions {
  syncProfile?: boolean
  allowedEmailDomains?: string[]
  globalAllowedEmailDomains?: string[]
  signUpEnabled?: boolean
}

async function socialContext(
  label: string,
  options: SocialContextOptions = {}
): Promise<TestContext> {
  return createTestContext(label, {
    config: {
      signUp: {
        enabled: options.signUpEnabled ?? true,
        requireApproval: false,
        allowedEmailDomains: options.globalAllowedEmailDomains ?? [],
      },
      // Social callbacks never present a password, and verification would
      // gate the session for a reason unrelated to what these tests assert.
      auth: { requireEmailVerification: false },
      social: {
        google: {
          enabled: true,
          clientId: "mock-client-id",
          clientSecret: "mock-client-secret",
          syncProfile: options.syncProfile ?? true,
          allowedEmailDomains: options.allowedEmailDomains ?? [],
          ...provider.providerOptions(),
        },
      },
    },
  })
}

interface CallbackResult {
  status: number
  location: string
  cookies: string[]
}

/**
 * Runs one complete social sign-in and returns where the callback sent the
 * browser.
 *
 * Better Auth binds the OAuth `state` to a cookie it sets on `/sign-in/social`,
 * so the cookies have to travel with the callback exactly as a browser would
 * carry them — which is also what makes the CSRF protection real here rather
 * than bypassed.
 */
async function signInWithProvider(
  context: TestContext,
  identity: Parameters<MockOidcProvider["setIdentity"]>[0]
): Promise<CallbackResult> {
  provider.setIdentity(identity)

  const start = await context.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "http://localhost:3000/account",
      }),
    })
  )
  const started = (await start.json()) as { url?: string }
  expect(
    started.url,
    "sign-in/social should hand back an authorize URL"
  ).toBeTruthy()
  const startCookies = start.headers.getSetCookie()

  // The provider answers the authorize request with a redirect carrying the
  // code; follow it by hand so nothing depends on redirect-following defaults.
  const authorized = await fetch(started.url!, { redirect: "manual" })
  const back = authorized.headers.get("location")
  expect(back, "the provider should redirect back with a code").toBeTruthy()

  const callback = await context.auth.handler(
    new Request(back!, {
      headers: { cookie: cookieHeader(startCookies) },
      redirect: "manual",
    })
  )

  return {
    status: callback.status,
    location: callback.headers.get("location") ?? "",
    cookies: callback.headers.getSetCookie(),
  }
}

function cookieHeader(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ")
}

function hasSessionCookie(cookies: string[]): boolean {
  return cookies.some(
    (cookie) =>
      cookie.includes("session_token") && !/session_token=;/.test(cookie)
  )
}

async function userByEmail(context: TestContext, email: string) {
  const [row] = await context.database.db
    .select()
    .from(context.database.schema.user)
    .where(eq(context.database.schema.user.email, email))
    .limit(1)
  return row
}

describe("social sign-in", () => {
  it("registers an identity the provider vouches for (FR-SOC-1)", async () => {
    const context = await socialContext("social_register")
    try {
      const result = await signInWithProvider(context, {
        sub: "google-1",
        email: "New.User@example.com",
        givenName: "New",
        familyName: "User",
      })

      expect(hasSessionCookie(result.cookies)).toBe(true)

      // FR-AUTH-1: the address is stored trimmed and lower-cased whatever the
      // provider sent.
      const user = await userByEmail(context, "new.user@example.com")
      expect(user).toBeDefined()
      // FR-SIGNUP-5: `given_name`/`family_name` land in their own columns.
      expect(user?.firstName).toBe("New")
      expect(user?.lastName).toBe("User")
    } finally {
      await context.teardown()
    }
  })

  it("refuses a provider address outside the per-provider domain list (FR-SOC-3)", async () => {
    const context = await socialContext("social_domain", {
      allowedEmailDomains: ["allowed.example"],
    })
    try {
      const refused = await signInWithProvider(context, {
        sub: "google-2",
        email: "someone@other.example",
      })
      expect(hasSessionCookie(refused.cookies)).toBe(false)
      expect(
        await userByEmail(context, "someone@other.example")
      ).toBeUndefined()

      const admitted = await signInWithProvider(context, {
        sub: "google-3",
        email: "someone@allowed.example",
      })
      expect(hasSessionCookie(admitted.cookies)).toBe(true)
    } finally {
      await context.teardown()
    }
  })

  it("refreshes the profile on every sign-in when syncProfile is on (FR-SOC-4)", async () => {
    const context = await socialContext("social_sync_on", { syncProfile: true })
    try {
      await signInWithProvider(context, {
        sub: "google-4",
        email: "sync@example.com",
        name: "Original Name",
      })
      await signInWithProvider(context, {
        sub: "google-4",
        email: "sync@example.com",
        name: "Renamed At Provider",
      })

      const user = await userByEmail(context, "sync@example.com")
      expect(user?.name).toBe("Renamed At Provider")
    } finally {
      await context.teardown()
    }
  })

  it("leaves the profile alone when syncProfile is off (FR-SOC-4)", async () => {
    const context = await socialContext("social_sync_off", {
      syncProfile: false,
    })
    try {
      await signInWithProvider(context, {
        sub: "google-5",
        email: "nosync@example.com",
        name: "Original Name",
      })
      await signInWithProvider(context, {
        sub: "google-5",
        email: "nosync@example.com",
        name: "Renamed At Provider",
      })

      const user = await userByEmail(context, "nosync@example.com")
      expect(user?.name).toBe("Original Name")
    } finally {
      await context.teardown()
    }
  })

  it("refuses a sync that would take another user's address, and records it (D24, FR-SOC-2)", async () => {
    const context = await socialContext("social_conflict", {
      syncProfile: true,
    })
    try {
      // Two separate provider subjects, two separate local users.
      await signInWithProvider(context, {
        sub: "google-owner",
        email: "owner@example.com",
        name: "Owner",
      })
      await signInWithProvider(context, {
        sub: "google-mover",
        email: "mover@example.com",
        name: "Mover",
      })

      // The second identity now claims the first one's address.
      const conflicted = await signInWithProvider(context, {
        sub: "google-mover",
        email: "owner@example.com",
        name: "Mover",
      })

      expect(hasSessionCookie(conflicted.cookies)).toBe(false)

      // Both rows untouched: the owner keeps the address and the mover keeps
      // its own, which is the part a unique-index violation would not give.
      const owner = await userByEmail(context, "owner@example.com")
      expect(owner?.name).toBe("Owner")
      const mover = await userByEmail(context, "mover@example.com")
      expect(mover?.name).toBe("Mover")

      const audit = await context.database.db
        .select()
        .from(context.database.schema.auditLog)
        .where(
          eq(context.database.schema.auditLog.action, "social.profile_conflict")
        )
      expect(audit).toHaveLength(1)
      expect(audit[0]?.outcome).toBe("failure")
      expect(audit[0]?.metadata).toMatchObject({ providerId: "google" })
    } finally {
      await context.teardown()
    }
  })
})
