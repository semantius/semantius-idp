/**
 * Resuming — and failing to resume — an interrupted authorization
 * (FR-OIDC-9).
 *
 * The happy path is covered by `integration/authorize-flow.test.ts` against a
 * real provider. What is worth pinning down here is everything that happens
 * when the signed request is *not* good: expired, tampered with, or answered
 * by a version of the plugin that names its fields differently. Those are the
 * paths a user hits after a sign-in has already succeeded, so getting them
 * wrong strands somebody who is logged in — the most confusing failure this
 * flow has.
 */

import { describe, expect, it, vi } from "vitest"

import { parseBasePath } from "@/server/config/derive"
import {
  OAUTH_QUERY_FIELD,
  resumeAuthorization,
} from "@/server/oidc/continuation"
import type { Runtime } from "@/server/runtime"

const BASE = parseBasePath("http://localhost:3000/idp")

interface Call {
  url: string
  headers: Headers
  body: unknown
}

function runtimeWith(response: Response, calls: Call[] = []) {
  const warn = vi.fn()
  const runtime = {
    config: { base: BASE },
    logger: { warn },
    auth: {
      handler: async (request: Request) => {
        calls.push({
          url: request.url,
          headers: request.headers,
          body: await request.json().catch(() => undefined),
        })
        return response
      },
    },
  } as unknown as Runtime
  return { runtime, warn, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const REQUEST = new Request("http://localhost:3000/idp/login", {
  headers: { cookie: "existing=1", origin: "http://localhost:3000" },
})

describe("resumeAuthorization", () => {
  it("does nothing at all when there is no authorization to resume", async () => {
    const { runtime, calls } = runtimeWith(json({}))
    await expect(
      resumeAuthorization(runtime, REQUEST, undefined)
    ).resolves.toEqual({})
    // Not merely "no destination": an ordinary sign-in must not cost a request
    // to the provider.
    expect(calls).toHaveLength(0)
    await expect(resumeAuthorization(runtime, REQUEST, "")).resolves.toEqual({})
    expect(calls).toHaveLength(0)
  })

  it("posts the signed request to /oauth2/continue with the caller's identity", async () => {
    const calls: Call[] = []
    const { runtime } = runtimeWith(
      json({ redirect: true, url: "https://app.example/cb?code=abc" }),
      calls
    )

    const result = await resumeAuthorization(runtime, REQUEST, "sig=1&x=2")

    expect(result).toEqual({ destination: "https://app.example/cb?code=abc" })
    expect(calls[0]?.url).toBe(
      "http://localhost:3000/idp/api/auth/oauth2/continue"
    )
    expect(calls[0]?.body).toEqual({
      selected: true,
      [OAUTH_QUERY_FIELD]: "sig=1&x=2",
    })
    // JSON out, so the answer is a URL this handler can turn into its own 303
    // rather than a redirect it cannot see.
    expect(calls[0]?.headers.get("accept")).toBe("application/json")
    expect(calls[0]?.headers.get("origin")).toBe("http://localhost:3000")
    expect(calls[0]?.headers.get("cookie")).toBe("existing=1")
  })

  it("replays a session cookie that no browser has sent back yet", async () => {
    // The session created by *this* request exists only as a `Set-Cookie` on
    // the response being built. Without replaying it the resume runs
    // anonymously and bounces the user back to the login page they just left.
    const calls: Call[] = []
    const { runtime } = runtimeWith(
      json({ url: "https://app.example/cb" }),
      calls
    )

    await resumeAuthorization(runtime, REQUEST, "sig=1", [
      "session=abc; Path=/idp; HttpOnly; SameSite=Lax",
      "session_data=xyz; Path=/idp",
    ])

    // Only the name=value pair travels; the attributes are the browser's
    // business and `Cookie` has no grammar for them.
    expect(calls[0]?.headers.get("cookie")).toBe(
      "existing=1; session=abc; session_data=xyz"
    )
  })

  it("works from a request that carries neither cookie nor origin", async () => {
    const calls: Call[] = []
    const { runtime } = runtimeWith(
      json({ url: "https://app.example/cb" }),
      calls
    )

    await resumeAuthorization(
      runtime,
      new Request("http://localhost:3000/idp/login"),
      "sig=1"
    )

    expect(calls[0]?.headers.get("cookie")).toBeNull()
    expect(calls[0]?.headers.get("origin")).toBeNull()
  })

  it("reads `redirect_uri` too, in case the plugin changes its mind", async () => {
    const { runtime } = runtimeWith(
      json({ redirect_uri: "https://app.example/cb?code=def" })
    )
    await expect(
      resumeAuthorization(runtime, REQUEST, "sig=1")
    ).resolves.toEqual({ destination: "https://app.example/cb?code=def" })
  })

  it("reports an expired or tampered request as unresumable, not as an error", async () => {
    const { runtime, warn } = runtimeWith(
      json({ message: "invalid signature" }, 400)
    )
    await expect(
      resumeAuthorization(runtime, REQUEST, "sig=tampered")
    ).resolves.toEqual({ invalid: true })
    // The sign-in that just succeeded still has to land somewhere sensible, so
    // this is a warning about the request, not a failure of the sign-in.
    expect(warn).toHaveBeenCalledWith(
      "could not resume an authorization request",
      { status: 400 }
    )
  })

  it("treats a 200 with no destination as unresumable as well", async () => {
    const { runtime } = runtimeWith(json({ redirect: true }))
    await expect(
      resumeAuthorization(runtime, REQUEST, "sig=1")
    ).resolves.toEqual({ invalid: true })
  })

  it("survives a response that is not JSON at all", async () => {
    const { runtime } = runtimeWith(new Response("<html>gateway</html>"))
    await expect(
      resumeAuthorization(runtime, REQUEST, "sig=1")
    ).resolves.toEqual({ invalid: true })
  })

  it("ignores an empty string where a URL was expected", async () => {
    const { runtime } = runtimeWith(json({ url: "", redirect_uri: "" }))
    await expect(
      resumeAuthorization(runtime, REQUEST, "sig=1")
    ).resolves.toEqual({ invalid: true })
  })
})
