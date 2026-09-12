/**
 * `{issuer}/.well-known/oauth-protected-resource` — RFC 9728 metadata for a
 * resource server this deployment fronts (FR-OIDC-18, **D129**).
 *
 * **Why an authorization server publishes it at all.** RFC 9728 documents
 * belong to the *resource* server, and the resource server here is PostgREST
 * or something equally unable to serve a well-known document. A client — the
 * `semantius` CLI, any MCP client — starts from the host it was given and
 * walks RFC 9728 → RFC 8414: protected-resource document first, then the
 * authorization server that document names. With the first hop missing the
 * walk stops at a 404 and the second hop, which has worked here since M8c, is
 * never reached. So this app serves the resource's document on the resource's
 * behalf, on the one origin they share. That sharing is the precondition, and
 * it is why {@link ProtectedResourceConfig} is a path and not a URI.
 *
 * **The two rules a client enforces, and where each is kept.**
 *
 *  - `authorization_servers[0]` must be the issuer **byte-for-byte**: the
 *    client derives `<origin>/.well-known/oauth-authorization-server<path>`
 *    from it and then requires *that* document to declare the same issuer
 *    back, which is what stops a host from claiming an issuer it does not
 *    serve. Both ends therefore come from one value —
 *    {@link currentRequestIssuer}, the issuer resolved once at the edge — so
 *    `server.dynamicIssuer` moves the pair together and cannot move one of
 *    them.
 *  - `scopes_supported` is **appended** to the scopes the client already asks
 *    for and sent verbatim to `/oauth2/authorize`, where an unknown scope
 *    fails the authorization. Nothing here can catch that at request time;
 *    `cross-checks.ts` refuses an undeclared scope at boot instead.
 *
 * **Two paths, one body.** The root URL is what the CLI reads, and RFC 9728
 * §3.1's derivation for a resource with a path is the suffix form
 * (`…/oauth-protected-resource/rest`); both are served, so neither kind of
 * client has to be right about the other. Only the root URL is listed on
 * `/admin/system` — see `discoveryUrls`.
 */

import { createBasePaths } from "./base-path"
import { corsFor, preflightResponse, withCors } from "../http/cors"
import { currentRequestIssuer } from "../http/request-log"
import type { ProtectedResourceConfig } from "../config/schema/config-schema"
import type { Runtime } from "../runtime"

/**
 * How long a client may cache the document.
 *
 * `private`, and five minutes, for the reason `forwardDiscovery` gives about
 * the discovery documents: under `server.dynamicIssuer` the body varies by the
 * host the request arrived on, and a shared cache keyed loosely could hand
 * host A's document to host B.
 */
const METADATA_MAX_AGE_SECONDS = 300

/** The document, exactly the fields RFC 9728 needs for a bearer-token API. */
export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported: string[]
  bearer_methods_supported: string[]
}

/**
 * The document for one configured resource, as answered on `issuer`.
 *
 * `resource` is the issuer's **origin** plus the configured path — not the
 * issuer plus the path, which under a sub-path deployment would be
 * `https://host/idp/rest` and name nothing. The issuer always parses: it is
 * either `server.baseUrl` or a `${scheme}://${host}${basePath}` built from a
 * host that passed `normalizeHost`, so there is no unreachable failure arm
 * here to test.
 */
export function protectedResourceMetadata(
  resource: ProtectedResourceConfig,
  issuer: string
): ProtectedResourceMetadata {
  return {
    resource: `${new URL(issuer).origin}${resource.path}`,
    authorization_servers: [issuer],
    scopes_supported: [...resource.scopes],
    bearer_methods_supported: ["header"],
  }
}

/**
 * Which configured resource a request is asking about, or `undefined` for a
 * 404.
 *
 * `suffix` is the splat below `/.well-known/oauth-protected-resource`:
 * `undefined` on the root route, `"rest"` on `…/oauth-protected-resource/rest`.
 */
export function findProtectedResource(
  resources: readonly ProtectedResourceConfig[],
  suffix: string | undefined
): ProtectedResourceConfig | undefined {
  // The root URL. RFC 9728 §3.1 derives it from a resource with *no* path, and
  // every resource here has one, so strictly it derives nothing — it is
  // answered with the first configured resource because that is the document
  // the CLI and every MCP client reads first, and for a single-resource
  // deployment the only one they read at all (**D129**). A trailing slash is
  // the same URL to anything that built it by concatenation.
  if (suffix === undefined || suffix === "") return resources[0]
  // An exact comparison against the whole configured path, and that is what
  // makes the splat safe: the router hands it over **decoded** (**D110**), so
  // `..%2fadmin` arrives here as `../admin`. A traversal attempt matches no
  // configured path and 404s, where walking segments would have had to get the
  // normalization right.
  return resources.find((resource) => resource.path === `/${suffix}`)
}

/**
 * The response for either route.
 *
 * A plain 404 rather than `notFound()` for an unconfigured or unmatched path,
 * for the reason `security.txt` records: throwing that inside a server handler
 * leaves the Start handler with nothing to return and the runtime answers with
 * its own default page.
 */
export function protectedResourceResponse(
  runtime: Runtime,
  request: Request,
  suffix?: string
): Response {
  const resource = findProtectedResource(
    runtime.config.file.oauth.protectedResources,
    suffix
  )
  if (resource === undefined) {
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    })
  }

  // Outside a request scope — a test calling this directly, the CLI — this is
  // the boot issuer, which is byte-for-byte what a deployment without
  // `server.dynamicIssuer` always answers.
  const issuer =
    currentRequestIssuer() ?? createBasePaths(runtime.config.base).issuer

  return withCors(
    Response.json(protectedResourceMetadata(resource, issuer), {
      headers: {
        "cache-control": `private, max-age=${METADATA_MAX_AGE_SECONDS}`,
      },
    }),
    // `public`, the same answer discovery and JWKS get: an unauthenticated
    // document every client has to read before it can do anything, so
    // restricting it protects nothing and breaks every browser-based client.
    corsFor(request, runtime.config, "public")
  )
}

/** The preflight, for a browser client that sends one. */
export function protectedResourcePreflight(
  runtime: Runtime,
  request: Request
): Response {
  return preflightResponse(corsFor(request, runtime.config, "public"))
}
