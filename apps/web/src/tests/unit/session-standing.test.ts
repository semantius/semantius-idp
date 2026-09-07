/**
 * The standing gates from the security review, in the arms a live
 * database cannot cheaply be put into.
 *
 *  - `auth/options/session-standing.ts` — the before-hook gate and the refresh-owner re-check, with the
 *    session lookup and the database injected;
 *  - `http/session.ts` — `readSession` refusing a user who may no longer sign
 *    in, cached copy or row;
 *  - `http/require-session.ts` — the origin refusal and the
 *    forced-change redirect, including the two spellings of `returnTo`.
 */

import { APIError } from "better-auth/api"
import { describe, expect, it, vi } from "vitest"

import {
  assertRefreshOwnerMaySignIn,
  assertSessionStanding,
  hashStoredToken,
  isExemptFromForcedChange,
} from "@/server/auth/options/session-standing"
import type { StandingContext } from "@/server/auth/options/session-standing"
import type { DbHandle } from "@/server/db/client"
import {
  browserPath,
  forcedChangeTarget,
  requireSession,
} from "@/server/http/require-session"
import { actorMetadata, readSession } from "@/server/http/session"
import type { Runtime } from "@/server/runtime"

function contextFor(
  path: string,
  overrides: Partial<StandingContext> = {}
): StandingContext {
  return {
    path,
    request: { method: "POST" },
    headers: new Headers({ cookie: "session_token=abc" }),
    context: { session: undefined },
    ...overrides,
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return (error as { body?: { code?: string } }).body?.code
  }
}

describe("isExemptFromForcedChange", () => {
  it("lets through what ends the condition or the session", () => {
    for (const path of [
      "/change-password",
      "/reset-password",
      "/sign-out",
      "/get-session",
      "/sign-in/email",
      "/two-factor/verify-totp",
      "/oauth2/token",
      "/oauth2/end-session",
    ]) {
      expect(isExemptFromForcedChange(path), path).toBe(true)
    }
  })

  it("holds everything else", () => {
    for (const path of [
      "/api-key/create",
      "/update-user",
      "/two-factor/enable",
      "/oauth2/continue",
      "/oauth2/consent",
      "/admin/create-user",
      "/idp/rotate-keys",
    ]) {
      expect(isExemptFromForcedChange(path), path).toBe(false)
    }
  })
})

describe("assertSessionStanding", () => {
  const flagged = { user: { mustChangePassword: true }, session: {} }
  const impersonated = {
    user: { mustChangePassword: false },
    session: { impersonatedBy: "admin-1" },
  }

  it("refuses a mint while a forced change is pending", async () => {
    const resolveSession = vi.fn().mockResolvedValue(flagged)
    await expect(
      codeOf(
        assertSessionStanding(contextFor("/api-key/create"), { resolveSession })
      )
    ).resolves.toBe("PASSWORD_CHANGE_REQUIRED")
  })

  it("refuses the session-JWT GET, which mints", async () => {
    const resolveSession = vi.fn().mockResolvedValue(flagged)
    await expect(
      codeOf(
        assertSessionStanding(
          contextFor("/token", { request: { method: "GET" } }),
          { resolveSession }
        )
      )
    ).resolves.toBe("PASSWORD_CHANGE_REQUIRED")
  })

  it("lets the change itself through", async () => {
    const resolveSession = vi.fn().mockResolvedValue(flagged)
    await expect(
      assertSessionStanding(contextFor("/change-password"), { resolveSession })
    ).resolves.toBeUndefined()
    // Exempt means not even looked up.
    expect(resolveSession).not.toHaveBeenCalled()
  })

  it("does not look up a plain read, or a request with no cookie", async () => {
    const resolveSession = vi.fn().mockResolvedValue(flagged)
    await assertSessionStanding(
      contextFor("/list-sessions", { request: { method: "GET" } }),
      { resolveSession }
    )
    await assertSessionStanding(
      contextFor("/api-key/create", { headers: new Headers() }),
      { resolveSession }
    )
    expect(resolveSession).not.toHaveBeenCalled()
  })

  it("reads the method off the endpoint when there is no request", async () => {
    // An `auth.api.*` call from our own server code has no `Request`.
    const resolveSession = vi.fn().mockResolvedValue(flagged)
    await assertSessionStanding(
      contextFor("/list-sessions", { request: null, method: "GET" }),
      { resolveSession }
    )
    expect(resolveSession).not.toHaveBeenCalled()
  })

  it("puts back the session an earlier hook resolved when the re-read finds nothing", async () => {
    // The api-key plugin's session: `getAuthoritativeSessionFromCtx` nulls it
    // before re-reading the cookie, and an API-key caller has no cookie worth
    // reading — so the preset has to survive, or every later hook sees an
    // anonymous request (`admin/gate.ts` documents the same trap).
    const preset = { user: { id: "key-owner" }, session: {} }
    const ctx = contextFor("/api-key/create", { context: { session: preset } })
    const resolveSession = vi.fn().mockImplementation(async (c: StandingContext) => {
      c.context.session = null
      return null
    })
    await assertSessionStanding(ctx, { resolveSession })
    expect(ctx.context.session).toBe(preset)
  })

  it("refuses an impersonating administrator's key mint, and nothing else of theirs", async () => {
    const resolveSession = vi.fn().mockResolvedValue(impersonated)
    await expect(
      codeOf(
        assertSessionStanding(contextFor("/api-key/create"), { resolveSession })
      )
    ).resolves.toBe("IMPERSONATED_SESSION")
    await expect(
      assertSessionStanding(contextFor("/update-user"), { resolveSession })
    ).resolves.toBeUndefined()
  })

  it("passes an ordinary session", async () => {
    const resolveSession = vi.fn().mockResolvedValue({
      user: { mustChangePassword: false },
      session: {},
    })
    await expect(
      assertSessionStanding(contextFor("/api-key/create"), { resolveSession })
    ).resolves.toBeUndefined()
  })
})

describe("assertRefreshOwnerMaySignIn", () => {
  /** A handle whose one query answers with the given owner row. */
  function databaseAnswering(owner: Record<string, unknown> | undefined): {
    database: DbHandle
    where: ReturnType<typeof vi.fn>
  } {
    const where = vi.fn().mockReturnValue({
      limit: async () => (owner ? [owner] : []),
    })
    const chain = {
      select: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      where,
    }
    return {
      where,
      database: {
        db: chain,
        schema: {
          oauthRefreshToken: { token: "token", userId: "userId" },
          user: {
            id: "id",
            status: "status",
            banned: "banned",
            banExpires: "banExpires",
          },
        },
      } as unknown as DbHandle,
    }
  }

  it("ignores anything but a refresh grant, and a grant with no database", async () => {
    const { database, where } = databaseAnswering({ status: "pending" })
    await assertRefreshOwnerMaySignIn(
      { grant_type: "authorization_code", code: "x" },
      { database }
    )
    await assertRefreshOwnerMaySignIn(
      { grant_type: "refresh_token", refresh_token: "" },
      { database }
    )
    await assertRefreshOwnerMaySignIn(
      { grant_type: "refresh_token", refresh_token: "rt" },
      {}
    )
    expect(where).not.toHaveBeenCalled()
  })

  it("leaves an unknown token to the provider", async () => {
    const { database } = databaseAnswering(undefined)
    await expect(
      assertRefreshOwnerMaySignIn(
        { grant_type: "refresh_token", refresh_token: "rt" },
        { database }
      )
    ).resolves.toBeUndefined()
  })

  it("answers invalid_grant for an owner who may not sign in", async () => {
    for (const owner of [
      { status: "pending", banned: false, banExpires: null },
      { status: "rejected", banned: false, banExpires: null },
      { status: "active", banned: true, banExpires: null },
    ]) {
      const { database } = databaseAnswering(owner)
      const error = await assertRefreshOwnerMaySignIn(
        { grant_type: "refresh_token", refresh_token: "rt" },
        { database }
      ).then(
        () => undefined,
        (thrown: unknown) => thrown
      )
      expect(error, JSON.stringify(owner)).toBeInstanceOf(APIError)
      expect((error as APIError).statusCode).toBe(400)
      expect((error as { body?: { error?: string } }).body?.error).toBe(
        "invalid_grant"
      )
    }
  })

  it("passes an active owner, and one whose ban has lapsed", async () => {
    for (const owner of [
      { status: "active", banned: false, banExpires: null },
      { status: "active", banned: true, banExpires: new Date(Date.now() - 1000) },
    ]) {
      const { database } = databaseAnswering(owner)
      await expect(
        assertRefreshOwnerMaySignIn(
          { grant_type: "refresh_token", refresh_token: "rt" },
          { database }
        )
      ).resolves.toBeUndefined()
    }
  })

  it("hashes the token the way the provider stores it", () => {
    // SHA-256 of "abc", base64url, unpadded — the provider's `defaultHasher`.
    expect(hashStoredToken("abc")).toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
    )
  })
})

function runtimeWith(session: unknown, basePath = ""): Runtime {
  return {
    auth: { api: { getSession: vi.fn().mockResolvedValue(session) } },
    config: { base: { basePath } },
  } as unknown as Runtime
}

const someone = (user: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "a@example.com", status: "active", ...user },
  session: {
    id: "s1",
    token: "t",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  },
})

const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/account/api-keys", {
    method: "POST",
    headers: { origin: "http://localhost:3000", ...headers },
  })

describe("readSession's standing gate", () => {
  it("answers null for a user who may no longer sign in", async () => {
    for (const user of [
      { status: "pending" },
      { status: "rejected" },
      { banned: true },
      { banned: true, banExpires: new Date(Date.now() + 60_000).toISOString() },
    ]) {
      await expect(
        readSession(runtimeWith(someone(user)), request()),
        JSON.stringify(user)
      ).resolves.toBeNull()
    }
  })

  it("keeps a user whose ban has lapsed, and an active one", async () => {
    for (const user of [
      {},
      { banned: true, banExpires: new Date(Date.now() - 60_000) },
    ]) {
      await expect(
        readSession(runtimeWith(someone(user)), request())
      ).resolves.not.toBeNull()
    }
  })
})

describe("requireSession's two new refusals", () => {
  it("refuses a cross-site post before reading anything", async () => {
    const runtime = runtimeWith(someone())
    const result = await requireSession(
      runtime,
      request({ "sec-fetch-site": "cross-site" }),
      "/account/api-keys"
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.headers.get("location")).toBe(
        "/account/api-keys?error=untrusted_origin"
      )
    }
    expect(runtime.auth.api.getSession).not.toHaveBeenCalled()
  })

  it("refuses a foreign Origin", async () => {
    const result = await requireSession(
      runtimeWith(someone()),
      request({ origin: "https://evil.example" }),
      "/account/api-keys"
    )
    expect(result.ok).toBe(false)
  })

  it("allows a post with neither header — not a browser", async () => {
    const result = await requireSession(
      runtimeWith(someone()),
      new Request("http://localhost:3000/account/api-keys", { method: "POST" }),
      "/account/api-keys"
    )
    expect(result.ok).toBe(true)
  })

  it("sends a pending forced change to the change page, with a way back", async () => {
    const result = await requireSession(
      runtimeWith(someone({ mustChangePassword: true })),
      request(),
      "/account/api-keys"
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.headers.get("location")).toBe(
        "/change-password?forced=1&returnTo=%2Faccount%2Fapi-keys"
      )
    }
  })

  it("does not prefix the mount path twice for an admin page", async () => {
    const result = await requireSession(
      runtimeWith(someone(), "/idp"),
      request({ "sec-fetch-site": "cross-site" }),
      "/idp/admin/system"
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.headers.get("location")).toBe(
        "/idp/admin/system?error=untrusted_origin"
      )
    }
  })
})

describe("the two path helpers", () => {
  it("browserPath accepts both spellings the handlers use", () => {
    expect(browserPath("", "/account")).toBe("/account")
    expect(browserPath("/idp", "/account")).toBe("/idp/account")
    expect(browserPath("/idp", "/idp/admin/system")).toBe("/idp/admin/system")
    expect(browserPath("/idp", "/idp")).toBe("/idp")
    // `/idpx` is not under the mount path.
    expect(browserPath("/idp", "/idpx/admin")).toBe("/idp/idpx/admin")
  })

  it("forcedChangeTarget carries forced=1 and the return path", () => {
    expect(forcedChangeTarget("/idp", "/account")).toBe(
      "/idp/change-password?forced=1&returnTo=%2Faccount"
    )
  })
})

describe("actorMetadata", () => {
  it("names the administrator, and nothing otherwise", () => {
    const base = someone()
    const own = {
      user: { ...base.user, name: "", emailVerified: true, roles: [], twoFactorEnabled: false, mustChangePassword: false },
      session: { ...base.session },
    }
    expect(actorMetadata(own)).toBeUndefined()
    expect(
      actorMetadata({
        ...own,
        session: { ...own.session, impersonatedBy: "admin-1" },
      })
    ).toEqual({ impersonatedBy: "admin-1" })
  })
})
