/**
 * A real OpenID Provider, on a real port (TST-7).
 *
 * Social sign-in is the one flow that cannot be tested by calling our own
 * code: the value is in what happens when a *provider* answers. So this is a
 * listener rather than a set of stubs — `Bun.serve` with `/authorize`,
 * `/token`, `/userinfo`, `/jwks` and a discovery document, signing real ES256
 * id tokens with a key it generates at start-up.
 *
 * Being a listener rather than an in-process fake is deliberate: M13 runs the
 * same flow against the **containerised** image, and nothing inside a
 * container can have its `fetch` patched from outside. The same fixture
 * serves both, with the container reaching it over the network.
 *
 * It is built on `node:http` rather than `Bun.serve` for one reason: Vitest
 * runs on Node, so a `Bun.serve` listener would be unreachable from the very
 * suite that needs it. The handler is still written against `Request` /
 * `Response`, so the Bun-hosted e2e run sees the same code.
 *
 * **The one thing that is not a listener.** Better Auth 1.7.1 hard-codes the
 * token endpoint of every built-in provider (`google` posts to
 * `oauth2.googleapis.com/token` whatever the options say); only
 * `authorizationEndpoint`, `getUserInfo` and `verifyIdToken` are overridable.
 * {@link MockOidcProvider.interceptTokenEndpoint} patches the global `fetch`
 * for that one URL and nothing else, and only for the duration of a test. M13
 * replaces it by pointing the container's DNS at this listener.
 *
 * Identity is per call: {@link MockOidcProvider.setIdentity} decides who the
 * next callback returns, so one listener serves a whole suite — including the
 * D24 case where two different subjects claim the same address.
 */

import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { SignJWT, exportJWK, generateKeyPair } from "jose"

import type { CryptoKey } from "jose"

export interface MockIdentity {
  /** The provider's subject identifier — `account.accountId` locally. */
  sub: string
  email: string
  emailVerified?: boolean
  name?: string
  givenName?: string
  familyName?: string
}

export interface MockOidcProvider {
  /** `http://127.0.0.1:<port>` */
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  /** Who the next token exchange and userinfo call describe. */
  setIdentity: (identity: MockIdentity) => void
  /** Every authorization request this listener has seen, newest last. */
  authorizeRequests: URL[]
  /**
   * Patches the global `fetch` so `tokenUrl` is answered by this listener.
   * Returns the undo function; call it in `afterAll`.
   */
  interceptTokenEndpoint: (tokenUrl: string) => () => void
  /** Options to merge into a `social.<provider>` config entry. */
  providerOptions: () => Record<string, unknown>
  stop: () => Promise<void>
}

const DEFAULT_IDENTITY: MockIdentity = {
  sub: "mock-subject",
  email: "user@example.com",
  emailVerified: true,
  name: "Mock User",
}

export async function startMockOidcProvider(): Promise<MockOidcProvider> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  })
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "mock-1",
    use: "sig",
    alg: "ES256",
  }

  let identity: MockIdentity = { ...DEFAULT_IDENTITY }
  const authorizeRequests: URL[] = []

  // `origin` is filled in the moment `Bun.serve` returns; the handler only
  // reads it per request, long after that.
  let origin = ""

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)

    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          userinfo_endpoint: `${origin}/userinfo`,
          jwks_uri: `${origin}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
        })

      case "/jwks":
        return json({ keys: [jwk] })

      case "/authorize": {
        // Records the request and bounces straight back with a code, which is
        // what a provider does once the user has consented. There is no login
        // page to drive: the identity is set by the test.
        authorizeRequests.push(url)
        const redirectUri = url.searchParams.get("redirect_uri")
        if (!redirectUri) {
          return new Response("missing redirect_uri", { status: 400 })
        }
        const back = new URL(redirectUri)
        back.searchParams.set("code", `mock-code-${identity.sub}`)
        const state = url.searchParams.get("state")
        if (state) back.searchParams.set("state", state)
        return new Response(null, {
          status: 302,
          headers: { location: back.toString() },
        })
      }

      case "/token": {
        const idToken = await signIdToken(privateKey, origin, identity)
        return json({
          access_token: `mock-access-${identity.sub}`,
          refresh_token: `mock-refresh-${identity.sub}`,
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
        })
      }

      case "/userinfo":
        return json(claimsFor(identity))

      default:
        return new Response("not found", { status: 404 })
    }
  }

  const server = createServer((incoming, outgoing) => {
    void serve(handle, origin, incoming, outgoing)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = (server.address() as AddressInfo).port

  origin = `http://127.0.0.1:${port}`

  const provider: MockOidcProvider = {
    issuer: origin,
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    userinfoEndpoint: `${origin}/userinfo`,
    authorizeRequests,
    setIdentity: (next) => {
      identity = next
    },
    interceptTokenEndpoint: (tokenUrl) => {
      const original = globalThis.fetch
      const patched = async (
        input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        const target =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (target.startsWith(tokenUrl))
          return original(`${origin}/token`, init)
        return original(input, init)
      }
      // `typeof fetch` carries runtime-specific extras (Bun adds
      // `preconnect`); the callers here only ever call it.
      globalThis.fetch = Object.assign(patched, {
        preconnect: original.preconnect,
      })
      return () => {
        globalThis.fetch = original
      }
    },
    providerOptions: () => ({
      // Overridable on every built-in provider; the token endpoint is not.
      authorizationEndpoint: `${origin}/authorize`,
    }),
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }

  return provider
}

function claimsFor(identity: MockIdentity): Record<string, unknown> {
  return {
    sub: identity.sub,
    email: identity.email,
    email_verified: identity.emailVerified ?? true,
    name: identity.name ?? identity.email,
    ...(identity.givenName ? { given_name: identity.givenName } : {}),
    ...(identity.familyName ? { family_name: identity.familyName } : {}),
    picture: "https://example.com/avatar.png",
  }
}

async function signIdToken(
  key: CryptoKey,
  issuer: string,
  identity: MockIdentity
): Promise<string> {
  return new SignJWT(claimsFor(identity))
    .setProtectedHeader({ alg: "ES256", kid: "mock-1" })
    .setIssuer(issuer)
    .setAudience("mock-client-id")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key)
}

/** Bridges one `node:http` exchange onto the fetch-shaped handler. */
async function serve(
  handle: (request: Request) => Promise<Response>,
  origin: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse
): Promise<void> {
  const body: BodyInit | undefined =
    incoming.method === "GET" || incoming.method === "HEAD"
      ? undefined
      : await readBody(incoming)
  const request = new Request(new URL(incoming.url ?? "/", origin), {
    method: incoming.method,
    headers: incoming.headers as Record<string, string>,
    body,
  })
  const response = await handle(request)
  outgoing.writeHead(
    response.status,
    Object.fromEntries(response.headers.entries())
  )
  outgoing.end(Buffer.from(await response.arrayBuffer()))
}

async function readBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of incoming) chunks.push(chunk as Uint8Array)
  // The only bodies this listener sees are form-encoded token requests.
  return Buffer.concat(chunks).toString("utf8")
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}
