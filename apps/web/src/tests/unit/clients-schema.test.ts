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

describe("client schema", () => {
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

  describe("no machine-to-machine in v1", () => {
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

describe("a file-declared secret has to look generated", () => {
  // The stored form is an unsalted SHA-256 (reconciliation and the token
  // endpoint share one function), so the only thing standing between a
  // database dump and a working client credential is the secret's entropy.
  it("accepts what a generator produces", () => {
    for (const secret of [
      "3f7a9c1e5b2d8046a1c3e5f7b9d0246813579bdf", // openssl rand -hex 20
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // hex 32
      "QmFzZTY0IHNlY3JldCB0aGF0IGxvb2tzIGdlbmVyYXRlZA+/==", // base64 48 bytes
      "c2f9e1a7-4b3d-4e8f-9a1b-6d7c8e9f0a1b-2c3d", // uuid-ish, 16 distinct
    ]) {
      expect(errorsFor(webClient({ clientSecret: secret })), secret).toBe("")
    }
  })

  it("rejects a placeholder built from one repeated character", () => {
    expect(errorsFor(webClient({ clientSecret: "s".repeat(40) }))).toContain(
      "distinct characters"
    )
  })

  it("accepts a placeholder that clears the floor: the marker is a cross-checks warning, not a refusal", () => {
    // An old development `.env` carries `example-…` for the two example
    // clients; refusing it here would stop a working checkout from booting.
    expect(
      errorsFor(webClient({ clientSecret: "example-web-client-secret-not-a-real-one" }))
    ).toBe("")
  })

  it("still names the length floor first for a short value", () => {
    expect(errorsFor(webClient({ clientSecret: "short" }))).toContain(
      "at least 32 characters"
    )
  })
})
