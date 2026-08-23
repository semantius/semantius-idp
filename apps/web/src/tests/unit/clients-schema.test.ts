import { describe, expect, it } from "vitest"

import {
  clientSchema,
  clientsFileSchema,
} from "@/server/config/schema/clients-schema"
import { spaClient, webClient } from "@/tests/fixtures/config-files"

function errorsFor(client: Record<string, unknown>): string {
  const result = clientSchema.safeParse(client)
  if (result.success) return ""
  return result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n")
}

describe("FR-OIDC-3 client schema", () => {
  it("accepts a confidential web client", () => {
    expect(clientSchema.safeParse(webClient()).success).toBe(true)
  })

  it("accepts a public SPA and a native client with a private-use scheme", () => {
    expect(clientSchema.safeParse(spaClient()).success).toBe(true)
    expect(
      clientSchema.safeParse({
        clientId: "mobile",
        type: "native",
        redirectUris: ["com.example.app:/oauth"],
        enableEndSession: false,
      }).success
    ).toBe(true)
  })

  it("applies the documented defaults", () => {
    const parsed = clientSchema.parse(webClient())
    expect(parsed.requirePKCE).toBe(true)
    expect(parsed.skipConsent).toBe(true)
    expect(parsed.enableEndSession).toBe(true)
    expect(parsed.firstParty).toBe(false)
    expect(parsed.disabled).toBe(false)
    expect(parsed.resourceServer).toBe(false)
  })

  describe("D26 — no machine-to-machine in v1", () => {
    it('rejects type: "service" and points at per-user API keys', () => {
      const text = errorsFor({ ...webClient(), type: "service" })
      expect(text).toContain("not supported in v1")
      expect(text).toContain("per-user API key")
    })

    it("rejects a client_credentials grant", () => {
      const text = errorsFor(webClient({ grantTypes: ["client_credentials"] }))
      expect(text).toContain(
        "`client_credentials` grant is not supported in v1"
      )
    })

    it("accepts the two supported grants", () => {
      expect(
        clientSchema.safeParse(
          webClient({ grantTypes: ["authorization_code", "refresh_token"] })
        ).success
      ).toBe(true)
    })
  })

  describe("secrets and auth methods", () => {
    it("rejects a public client carrying a secret", () => {
      expect(errorsFor(spaClient({ clientSecret: "s".repeat(40) }))).toContain(
        "must not carry a client secret"
      )
    })

    it("rejects a confidential client without a secret", () => {
      const client = webClient()
      delete client.clientSecret
      expect(errorsFor(client)).toContain("requires a `clientSecret`")
    })

    it("rejects a client secret shorter than 32 characters", () => {
      expect(errorsFor(webClient({ clientSecret: "short" }))).toContain(
        "at least 32 characters"
      )
    })

    it("rejects client_secret_* on a public client and none on a confidential one", () => {
      expect(
        errorsFor(spaClient({ tokenEndpointAuthMethod: "client_secret_basic" }))
      ).toContain('auth method must be "none"')
      expect(
        errorsFor(webClient({ tokenEndpointAuthMethod: "none" }))
      ).toContain("not a valid token endpoint auth method")
    })
  })

  describe("redirect URIs", () => {
    it("requires at least one", () => {
      expect(errorsFor(webClient({ redirectUris: [] }))).toContain(
        "At least one redirect URI is required"
      )
    })

    it("rejects wildcards, fragments and relative URIs", () => {
      expect(
        errorsFor(webClient({ redirectUris: ["https://*.example.com/cb"] }))
      ).toContain("wildcard")
      expect(
        errorsFor(webClient({ redirectUris: ["https://app.example.com/cb#x"] }))
      ).toContain("fragment")
      expect(errorsFor(webClient({ redirectUris: ["/callback"] }))).toContain(
        "not an absolute URI"
      )
    })

    it("allows plain http only on loopback", () => {
      expect(
        errorsFor(webClient({ redirectUris: ["http://app.example.com/cb"] }))
      ).toContain("must use https")
      expect(
        clientSchema.safeParse(
          webClient({
            redirectUris: [
              "http://localhost:5173/cb",
              "http://127.0.0.1:5173/cb",
            ],
            postLogoutRedirectUris: ["http://localhost:5173/"],
          })
        ).success
      ).toBe(true)
    })

    it("allows a private-use scheme only for native clients", () => {
      expect(
        errorsFor(spaClient({ redirectUris: ["com.example.app:/oauth"] }))
      ).toContain("only allowed for")
    })
  })

  it("requires a post-logout redirect URI when end-session is enabled", () => {
    expect(errorsFor(webClient({ postLogoutRedirectUris: [] }))).toContain(
      "`enableEndSession` requires"
    )
  })

  it("rejects unknown fields", () => {
    expect(errorsFor(webClient({ audienceOverride: "https://x" }))).toContain(
      "Unrecognized key"
    )
  })

  it("defaults an absent clients file to an empty list", () => {
    expect(clientsFileSchema.parse({}).clients).toEqual([])
  })
})
