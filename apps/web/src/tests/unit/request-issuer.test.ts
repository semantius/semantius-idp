import { describe, expect, it } from "vitest"

import { parseBasePath } from "@/server/config/derive"
import { resolveRequestIssuer } from "@/server/oidc/request-issuer"

/**
 * `server.dynamicIssuer` — the resolver, as a matrix (SEC-1's one sanctioned
 * exception).
 *
 * The fail-safe half is the one that matters: with the flag off, the answer
 * is the boot issuer whatever the request carries, byte for byte.
 */

const HOSTILE_HEADERS = {
  host: "evil.example.com",
  "x-forwarded-host": "evil.example.com",
  "x-forwarded-proto": "https",
}

function requestWith(headers: Record<string, string> = {}): Request {
  return new Request("https://canonical.example.com/idp/x", { headers })
}

const off = parseBasePath("https://canonical.example.com/idp")
const on = parseBasePath("https://canonical.example.com/idp", {
  dynamicIssuer: true,
})

describe("dynamicIssuer off — the fail-safe", () => {
  it("returns the boot issuer whatever the headers say", () => {
    expect(
      resolveRequestIssuer(off, requestWith(HOSTILE_HEADERS), {
        trustProxy: true,
      })
    ).toBe("https://canonical.example.com/idp")
    expect(
      resolveRequestIssuer(off, requestWith(HOSTILE_HEADERS), {
        trustProxy: false,
      })
    ).toBe("https://canonical.example.com/idp")
  })
})

describe("dynamicIssuer on", () => {
  it("follows the leftmost X-Forwarded-Host under trustProxy", () => {
    expect(
      resolveRequestIssuer(
        on,
        requestWith({ "x-forwarded-host": "b.example.com, proxy.internal" }),
        { trustProxy: true }
      )
    ).toBe("https://b.example.com/idp")
  })

  it("ignores X-Forwarded-Host when no proxy is trusted", () => {
    expect(
      resolveRequestIssuer(
        on,
        requestWith({
          "x-forwarded-host": "b.example.com",
          host: "c.example.com",
        }),
        { trustProxy: false }
      )
    ).toBe("https://c.example.com/idp")
  })

  it("falls back to Host, then to the URL host", () => {
    expect(
      resolveRequestIssuer(on, requestWith({ host: "c.example.com:8443" }), {
        trustProxy: true,
      })
    ).toBe("https://c.example.com:8443/idp")
    // A Request built in-process: undici sets no `host` header by itself, so
    // the URL is what names the address.
    expect(
      resolveRequestIssuer(on, new Request("https://d.example.com/idp/x"), {
        trustProxy: true,
      })
    ).toBe("https://d.example.com/idp")
  })

  it("takes the scheme from the boot issuer, never from the request", () => {
    const httpBase = parseBasePath("http://localhost:3000/idp", {
      dynamicIssuer: true,
    })
    expect(
      resolveRequestIssuer(
        httpBase,
        requestWith({
          host: "b.example.com",
          "x-forwarded-proto": "https",
        }),
        { trustProxy: false }
      )
    ).toBe("http://b.example.com/idp")
  })

  it.each([
    ["*", "wildcard"],
    ["?.example.com", "question mark"],
    ["evil.example/path", "smuggled path"],
    ["https://evil.example", "smuggled scheme"],
    ["user@evil.example", "credentials"],
    ["evil.example com", "whitespace"],
  ])("refuses %s (%s) and answers with the boot issuer", (value) => {
    expect(
      resolveRequestIssuer(on, requestWith({ "x-forwarded-host": value }), {
        trustProxy: true,
      })
    ).toBe("https://canonical.example.com/idp")
  })

  it("keeps the mount path whatever the host resolves to", () => {
    const rootBase = parseBasePath("https://canonical.example.com", {
      dynamicIssuer: true,
    })
    expect(
      resolveRequestIssuer(rootBase, requestWith({ host: "b.example.com" }), {
        trustProxy: false,
      })
    ).toBe("https://b.example.com")
  })
})

describe("runtime assumption the synthetic requests rely on", () => {
  it("a Request built from copied headers keeps its host header (Node and Bun)", () => {
    // `auth-proxy.ts` clones the incoming headers into a new Request; the
    // origin check downstream reads `host` from them. This holds on Node
    // 22's undici; the assertion is here so a Bun run fails loudly if its
    // fetch implementation strips or rewrites the header instead.
    const original = new Request("https://canonical.example.com/idp/login", {
      headers: { host: "b.example.com", cookie: "idp.session=x" },
    })
    const copied = new Request("https://canonical.example.com/idp/api/auth/x", {
      method: "POST",
      headers: new Headers(original.headers),
      body: "{}",
    })
    expect(copied.headers.get("host")).toBe("b.example.com")
  })
})
