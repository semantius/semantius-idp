import { describe, expect, it } from "vitest"

import { parseBasePath } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import type { ProtectedResourceConfig } from "@/server/config/schema/config-schema"
import { withRequestContext } from "@/server/http/request-log"
import {
  findProtectedResource,
  protectedResourceMetadata,
  protectedResourcePreflight,
  protectedResourceResponse,
} from "@/server/oidc/protected-resource"
import type { Runtime } from "@/server/runtime"

/**
 * RFC 9728 protected-resource metadata (FR-OIDC-18, **D129**).
 *
 * A unit test and not an integration one, for the reason `discovery.test.ts`
 * gives about the protocol proxy: the two routes are three lines each and
 * everything worth asserting is in the module they call. It is also what the
 * 85 % branch gate over `src/server/oidc/**` needs — a request-driven test
 * reaches the happy path and leaves the 404 arms untaken.
 *
 * What each assertion is protecting:
 *
 *  - **`resource` is the origin plus the path, never the issuer plus the
 *    path.** Under the sub-path deployment the second spelling is
 *    `https://host/idp/rest`, which names nothing, and a client compares
 *    `resource` byte-for-byte against the document it asked for.
 *  - **`authorization_servers[0]` is the issuer byte-for-byte**, and moves
 *    with it under `server.dynamicIssuer`. The client derives the RFC 8414
 *    metadata URL from this value and then requires that document to name the
 *    same issuer back, so a pair that can drift apart is a login that fails
 *    with no useful message.
 *  - **An unconfigured deployment 404s** rather than publishing a document
 *    about a resource server it does not front.
 */

function runtimeFor(
  baseUrl: string,
  protectedResources: ProtectedResourceConfig[]
): Runtime {
  return {
    config: {
      base: parseBasePath(baseUrl),
      file: { oauth: { protectedResources } },
    } as unknown as IdpConfig,
  } as unknown as Runtime
}

async function documentFor(
  runtime: Runtime,
  path: string,
  suffix?: string
): Promise<Record<string, unknown>> {
  const response = protectedResourceResponse(
    runtime,
    new Request(`https://ignored.invalid${path}`),
    suffix
  )
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

const REST: ProtectedResourceConfig = { path: "/rest", scopes: [] }
const MCP: ProtectedResourceConfig = { path: "/mcp", scopes: [] }

describe("protectedResourceMetadata", () => {
  it("names the resource on the origin and the issuer with its path", () => {
    expect(
      protectedResourceMetadata(REST, "https://apps.example.com/idp")
    ).toEqual({
      resource: "https://apps.example.com/rest",
      authorization_servers: ["https://apps.example.com/idp"],
      scopes_supported: [],
      bearer_methods_supported: ["header"],
    })
  })

  it("is the same document at the host root, where the two coincide", () => {
    expect(
      protectedResourceMetadata(REST, "https://idp.example.com")
    ).toMatchObject({
      resource: "https://idp.example.com/rest",
      authorization_servers: ["https://idp.example.com"],
    })
  })

  it("publishes the configured scopes verbatim", () => {
    expect(
      protectedResourceMetadata(
        { path: "/rest", scopes: ["openid", "profile"] },
        "https://idp.example.com"
      ).scopes_supported
    ).toEqual(["openid", "profile"])
  })

  it("copies the scopes rather than aliasing the configuration", () => {
    const scopes = ["openid"]
    const published = protectedResourceMetadata(
      { path: "/rest", scopes },
      "https://idp.example.com"
    ).scopes_supported
    published.push("mutated")
    expect(scopes).toEqual(["openid"])
  })
})

describe("findProtectedResource", () => {
  it("answers the root URL with the first configured resource", () => {
    // The root URL is the one the CLI reads, and RFC 9728 §3.1 derives it
    // from a resource with no path at all — so it is a convention, decided
    // here (**D129**) rather than derived.
    expect(findProtectedResource([REST, MCP], undefined)).toBe(REST)
    expect(findProtectedResource([REST, MCP], "")).toBe(REST)
  })

  it("matches the §3.1 suffix form against the whole configured path", () => {
    expect(findProtectedResource([REST, MCP], "mcp")).toBe(MCP)
    expect(findProtectedResource([REST, MCP], "v1/items")).toBeUndefined()
    expect(
      findProtectedResource([{ path: "/v1/items", scopes: [] }], "v1/items")
    ).toMatchObject({ path: "/v1/items" })
  })

  it("refuses a traversal the router has already decoded", () => {
    // TanStack `decodeURIComponent`s the splat (**D110**), so `..%2fadmin`
    // arrives here as `../admin`. The whole-string comparison is what makes
    // that a 404 instead of a normalization problem.
    expect(findProtectedResource([REST], "../admin")).toBeUndefined()
    expect(findProtectedResource([REST], "../rest")).toBeUndefined()
    expect(findProtectedResource([REST], "rest/../rest")).toBeUndefined()
  })

  it("finds nothing when nothing is configured", () => {
    expect(findProtectedResource([], undefined)).toBeUndefined()
    expect(findProtectedResource([], "rest")).toBeUndefined()
  })
})

describe("protectedResourceResponse", () => {
  it("serves the document at the root URL and at the suffix form", async () => {
    const runtime = runtimeFor("https://apps.example.com/idp", [REST, MCP])
    const root = await documentFor(
      runtime,
      "/idp/.well-known/oauth-protected-resource"
    )
    const suffix = await documentFor(
      runtime,
      "/idp/.well-known/oauth-protected-resource/rest",
      "rest"
    )
    expect(root).toEqual(suffix)
    expect(root.resource).toBe("https://apps.example.com/rest")
  })

  it("answers JSON, cacheable privately, and readable from anywhere", async () => {
    const response = protectedResourceResponse(
      runtimeFor("https://idp.example.com", [REST]),
      new Request("https://idp.example.com/.well-known/oauth-protected-resource")
    )
    expect(response.headers.get("content-type")).toMatch(/^application\/json/)
    // `private`, like the discovery documents: the body varies by the host the
    // request arrived on under `server.dynamicIssuer`.
    expect(response.headers.get("cache-control")).toBe("private, max-age=300")
    // The same answer discovery and JWKS get — an unauthenticated document
    // every client must read first.
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })

  it("404s when no resource is configured, without a redirect", async () => {
    const response = protectedResourceResponse(
      runtimeFor("https://idp.example.com", []),
      new Request("https://idp.example.com/.well-known/oauth-protected-resource")
    )
    expect(response.status).toBe(404)
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("404s an unmatched suffix", () => {
    expect(
      protectedResourceResponse(
        runtimeFor("https://idp.example.com", [REST]),
        new Request(
          "https://idp.example.com/.well-known/oauth-protected-resource/other"
        ),
        "other"
      ).status
    ).toBe(404)
  })

  it("follows the request's issuer under server.dynamicIssuer", async () => {
    const runtime = runtimeFor("https://canonical.example.com/idp", [REST])
    const document = await withRequestContext(
      { requestId: "t", issuer: "https://tenant.example.net/idp" },
      async () =>
        documentFor(runtime, "/idp/.well-known/oauth-protected-resource")
    )
    // Both halves move together, which is the point: the client derives the
    // metadata URL from `authorization_servers[0]`.
    expect(document.authorization_servers).toEqual([
      "https://tenant.example.net/idp",
    ])
    expect(document.resource).toBe("https://tenant.example.net/rest")
  })
})

describe("protectedResourcePreflight", () => {
  it("answers a browser preflight with the public policy", () => {
    const response = protectedResourcePreflight(
      runtimeFor("https://idp.example.com", [REST]),
      new Request(
        "https://idp.example.com/.well-known/oauth-protected-resource",
        { method: "OPTIONS" }
      )
    )
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })
})
