/**
 * The issuer-root protocol endpoints.
 *
 * Better Auth mounts its OAuth endpoints under its own `basePath`
 * (`{issuer}/api/auth/oauth2/*`). The protocol says they belong at the issuer
 * root — `{issuer}/oauth2/*` and `{issuer}/.well-known/*` — and the difference
 * is not cosmetic: a client discovers those URLs once and hard-codes them, and
 * a discovery document that advertises `/api/auth/...` locks every client to
 * an internal detail of the auth library.
 *
 * So a thin route at each protocol path forwards to `auth.handler` and
 * post-processes the answer. What the post-processing is *for*:
 *
 * - **Discovery URLs are rewritten** to the issuer-root paths, and the `iss`
 *   the document advertises is asserted byte-equal to the configured issuer.
 *   `iss` mismatch is the single most common cause of "works in curl, fails in
 *   the client library": a verifier compares it as a string, so a trailing
 *   slash or a `/api/auth` suffix is a hard failure with an unhelpful message.
 * - **`Cache-Control`.** Tokens and userinfo are `no-store` because they carry
 *   credentials and personal data; JWKS is cached for five minutes with an
 *   ETag, because a verifier that refetches it on every request turns key
 *   distribution into a load-bearing dependency.
 * - **RFC 7009.** A revocation request for an invalid token is a *success* —
 *   §2.2 is explicit — so a client cannot use the endpoint to find out which
 *   tokens exist. 1.7.1 answers `400 invalid_request` for one; that case is
 *   normalized on the error code and on what the proxy knows about the
 *   request, never on the description's wording, and every other error is
 *   passed through.
 *
 * Nothing here reads `Host` or `X-Forwarded-Host`: the forwarded URL
 * is rebuilt from `server.baseUrl`. The one issuer-shaped exception is
 * deliberate and indirect: under `server.dynamicIssuer` the request's
 * *resolved* issuer — computed once at the edge through `normalizeHost`, see
 * `request-issuer.ts` — is what discovery is rewritten to, read from the
 * request context rather than from any header here.
 */

import { createHash } from "node:crypto"

import { PROTOCOL_ROUTES, createBasePaths } from "./base-path"
import {
  currentAuthApiError,
  currentRequestIssuer,
} from "../http/request-log"
import type { Runtime } from "../runtime"

/** How long a verifier may cache the key set. */
const JWKS_MAX_AGE_SECONDS = 300

export interface ForwardOptions {
  /**
   * The path under Better Auth's mount, e.g. `/oauth2/token`. Not taken from
   * the request: the delegate names its own target, so a path-traversal
   * attempt in the URL cannot reach a different endpoint.
   */
  providerPath: string
  /**
   * Address the path from the **issuer** rather than from the auth mount.
   *
   * The discovery documents are the only endpoints Better Auth serves outside
   * its own `basePath`: `{issuer}/.well-known/openid-configuration`, not
   * `{issuer}/api/auth/.well-known/...`. Verified against the running router
   * rather than assumed — the first version of this file guessed and got 404s.
   */
  issuerRelative?: boolean
}

export async function forwardToAuth(
  runtime: Runtime,
  request: Request,
  { providerPath, issuerRelative = false }: ForwardOptions
): Promise<Response> {
  const paths = createBasePaths(runtime.config.base)
  const incoming = new URL(request.url)

  const base = issuerRelative ? paths.issuer : paths.authBaseUrl
  const target = new URL(`${base}${providerPath}${incoming.search}`)
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer()

  const response = await runtime.auth.handler(
    new Request(target, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: "manual",
    })
  )

  switch (providerPath) {
    case "/jwks":
      return withJwksHeaders(response)
    case "/oauth2/revoke":
      return normalizeRevocation(
        mapCrossHostTokenError(response),
        revocationFacts(request, body)
      )
    case "/oauth2/token":
      return withNoStore(response)
    case "/oauth2/userinfo":
    case "/oauth2/introspect":
      return withNoStore(mapCrossHostTokenError(response))
    default:
      return response
  }
}

/**
 * A host-scoped access token presented on another host (`server.dynamicIssuer`).
 *
 * The provider verifies a JWT access token with `{ issuer: expectedIssuer }`
 * from the same per-request getter that minted it, so a token from host A
 * presented on host B fails jose's `iss` check. That error matches none of
 * the provider's handled shapes and surfaces as a bare 500 on
 * `/oauth2/userinfo`, `/oauth2/introspect` and `/oauth2/revoke` — an answer
 * that reads as *our* outage when it is the caller's stale token. This maps
 * exactly that shape to a 401 `invalid_token`.
 *
 * Deliberately narrow, twice over. Only a 500 is ever touched, and only when
 * the stashed error is jose's `JWTClaimValidationFailed` **on `iss`** — a
 * token that failed for any other reason, or one that would have validated as
 * an *opaque* token (impossible here: the `iss` check only runs after the
 * signature verified, so the credential is one of our JWTs), keeps whatever
 * answer the provider gave. Tokens live 15 minutes, so this is also the whole
 * blast radius of switching hosts: outstanding tokens 401 until they expire.
 */
function mapCrossHostTokenError(response: Response): Response {
  if (response.status !== 500) return response
  const error = currentAuthApiError()
  if (
    !(error instanceof Error) ||
    error.name !== "JWTClaimValidationFailed" ||
    (error as { claim?: unknown }).claim !== "iss"
  ) {
    return response
  }
  return Response.json(
    {
      error: "invalid_token",
      error_description:
        "The access token was issued for a different host of this deployment.",
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": 'Bearer error="invalid_token"',
      },
    }
  )
}

/**
 * Discovery, with every endpoint URL moved to the issuer root.
 *
 * The rewrite is a backstop rather than the mechanism: the provider is
 * configured with `advertisedMetadata` where that reaches, and this catches
 * the fields it does not cover. Doing both is deliberate — a missed field
 * here is a client permanently pointed at `/api/auth`.
 */
export async function forwardDiscovery(
  runtime: Runtime,
  request: Request,
  providerPath: string
): Promise<Response> {
  const paths = createBasePaths(runtime.config.base)
  const response = await forwardToAuth(runtime, request, {
    providerPath,
    issuerRelative: true,
  })
  if (!response.ok) return response

  // The issuer THIS request resolved to at the edge: the boot issuer, unless
  // `server.dynamicIssuer` put the request's own host there. Outside a
  // request scope (tests calling this directly, the CLI) it is the boot
  // issuer, which is byte-for-byte the old behavior.
  //
  // `authBaseUrl` stays the STATIC one on purpose: the provider builds every
  // endpoint URL from `ctx.context.baseURL`, which does not vary by request,
  // and the rewrite below strips exactly that prefix. Passing a per-request
  // auth base here would make the strip miss every URL and ship canonical
  // `/api/auth` endpoints into the document.
  const issuer = currentRequestIssuer() ?? paths.issuer
  const document = (await response.json()) as Record<string, unknown>
  const rewritten = rewriteDiscovery(document, issuer, paths.authBaseUrl, {
    uiLocale: runtime.config.file.site.defaultLocale,
  })

  // There is deliberately no issuer assertion here any more. The old guard
  // compared `rewritten.issuer` to the expected issuer, and `rewriteDiscovery`
  // assigns that field from this function's own argument — the branch was
  // unreachable. Comparing the RAW `document.issuer` instead would break the
  // one legitimate topology where the two differ: the provider https-coerces
  // a non-loopback http issuer (`allowInsecureHttp` over a LAN IP), which the
  // rewrite has always papered over. the spec's real guarantee — `iss`
  // byte-equal to what this deployment calls itself — is the assignment in
  // `rewriteDiscovery`, and the tests assert it on the document.
  return Response.json(rewritten, {
    headers: {
      // Five minutes still keeps a restart visible, but `private`, not
      // `public`: the body varies by the host the request arrived on under
      // `dynamicIssuer`, and a shared cache keyed loosely could hand host A's
      // document to host B. (`Vary: Host` would be near-inert in caches keyed
      // on the absolute URL, and names the wrong header anyway — the input is
      // `X-Forwarded-Host`.)
      "cache-control": `private, max-age=${JWKS_MAX_AGE_SECONDS}`,
    },
  })
}

/**
 * Moves `{issuer}/api/auth/<x>` to `{issuer}/<x>` for every URL in the
 * document, and pins `issuer` and `jwks_uri` to the issuer root.
 *
 * Pure and exported so the mapping is testable without a server.
 */
export interface DiscoveryFacts {
  /** `site.defaultLocale`, advertised so a client can ask for it. */
  uiLocale: string
}

/**
 * The token-endpoint authentication methods this deployment really accepts
 *.
 *
 * 1.7.1 advertises `private_key_jwt`, which §1.3 deliberately does not use,
 * and omits `none`, which every public client needs. Both matter: a client
 * library reads this list and picks a method from it, so advertising one that
 * is unconfigured produces `invalid_client` at the worst possible moment, and
 * omitting `none` tells an SPA it must hold a secret.
 */
const TOKEN_ENDPOINT_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_post",
  "none",
]

export function rewriteDiscovery(
  document: Record<string, unknown>,
  issuer: string,
  authBaseUrl: string,
  facts: DiscoveryFacts = { uiLocale: "en-US" }
): Record<string, unknown> {
  const rewritten: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(document)) {
    rewritten[key] = rewriteValue(value, issuer, authBaseUrl)
  }

  rewritten.issuer = issuer
  // The canonical key set lives at the issuer root; `/api/auth/jwks` keeps
  // answering byte-identically for anything that already found it.
  rewritten.jwks_uri = `${issuer}${PROTOCOL_ROUTES.jwksWellKnown}`
  rewritten.token_endpoint_auth_methods_supported = [
    ...TOKEN_ENDPOINT_AUTH_METHODS,
  ]

  // Advertised as *unsupported* rather than omitted. A client
  // that reads an absent field may assume either answer; saying `false`
  // settles it, and these three are the request-object parameters §1.3
  // leaves out of v1.
  rewritten.request_parameter_supported = false
  rewritten.request_uri_parameter_supported = false
  rewritten.claims_parameter_supported = false
  rewritten.ui_locales_supported = [facts.uiLocale]

  return rewritten
}

function rewriteValue(
  value: unknown,
  issuer: string,
  authBaseUrl: string
): unknown {
  if (typeof value === "string") {
    return value.startsWith(authBaseUrl)
      ? `${issuer}${value.slice(authBaseUrl.length)}`
      : value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteValue(entry, issuer, authBaseUrl))
  }
  return value
}

async function withJwksHeaders(response: Response): Promise<Response> {
  if (!response.ok) return response
  const body = await response.text()
  // A weak-free ETag over the body: a rotation changes the set, so the tag
  // changes with it and a verifier's conditional request revalidates cheaply.
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`

  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${JWKS_MAX_AGE_SECONDS}`,
      etag,
    },
  })
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "no-store")
  headers.set("pragma", "no-cache")
  return new Response(response.body, { status: response.status, headers })
}

/**
 * What the proxy can see about a revocation request for itself, so the
 * normalization below never has to read the provider's prose.
 */
interface RevocationFacts {
  /** The request carried a non-empty `token`. */
  carriedToken: boolean
  /**
   * Client authentication was a shape the provider could have accepted: no
   * `Authorization` header (credentials in the body, or a public client) or a
   * Basic one. Any other scheme is refused as `invalid_request` before the
   * token is looked at, and that refusal is the client's to see.
   */
  acceptableAuthorization: boolean
}

function revocationFacts(
  request: Request,
  body: ArrayBuffer | undefined
): RevocationFacts {
  const token = body
    ? new URLSearchParams(new TextDecoder().decode(body)).get("token")
    : null
  const authorization = request.headers.get("authorization")
  return {
    carriedToken: token !== null && token !== "",
    acceptableAuthorization:
      authorization === null || /^basic\s/i.test(authorization),
  }
}

/**
 * RFC 7009 §2.2: an invalid token is a success.
 *
 * Only that one shape is normalized. An unauthenticated client (401) or an
 * unsupported token type is still an error, because each of those is the
 * *client's* mistake and hiding it would make integration harder for no
 * security gain.
 *
 * **What "invalid token" is keyed on.** The provider answers
 * `400 invalid_request`, and the only stable thing about that answer is the
 * `error` code: the `error_description` is prose it already spells three
 * ways ("token not found", "opaque access token not found", "Invalid access
 * token"), and the first version of this function matched one of them with a
 * regex — so a revoked or malformed token answered 400 and the endpoint was
 * an oracle after all. What separates "invalid token" from "malformed
 * request" is not in the response; it is in the request, and the proxy can
 * see it: after client authentication has succeeded, every 400
 * `invalid_request` the provider produces is about the token (not found,
 * revoked, unparseable), and the two it produces *before* authentication —
 * no token, an `Authorization` scheme it does not speak — are
 * {@link RevocationFacts} the proxy establishes for itself.
 */
async function normalizeRevocation(
  response: Response,
  facts: RevocationFacts
): Promise<Response> {
  if (response.status !== 400) return withNoStore(response)

  const body = await response.text()
  let parsed: { error?: unknown } = {}
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    })
  }

  const invalidToken =
    parsed.error === "invalid_request" &&
    facts.carriedToken &&
    facts.acceptableAuthorization

  if (!invalidToken) {
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    })
  }

  return new Response(null, {
    status: 200,
    headers: { "cache-control": "no-store" },
  })
}
