/**
 * Which address the browser thinks it is on (SEC-3, **D68**).
 *
 * Better Auth refuses a cookie-bearing post whose `Origin` is not in
 * `trustedOrigins`, and that list defaulted to `[server.baseUrl]` alone. A
 * deployment behind a reverse proxy therefore had to *know its own public URL
 * at configuration time* — and a deployment that is handed one later, or
 * reached through more than one name, could not sign anybody in. It is the
 * same refusal `127.0.0.1` meets against a `baseUrl` of `localhost` (**D57**),
 * just permanent.
 *
 * So when no allow-list is configured the check follows the request instead:
 * the `Origin` the browser sent has to name the same host the request arrived
 * on. That is still a real CSRF check — **a cross-site page cannot choose
 * either side of it**. `Origin` is set by the browser, and the host comes from
 * headers no cross-site request can forge:
 *
 *  - `Host` is set by the browser from the URL it is fetching, so a page on
 *    `evil.example` posting here still sends this deployment's host;
 *  - `X-Forwarded-Host` is not a CORS-safelisted header, so adding it to a
 *    cross-site request triggers a preflight that this server never answers.
 *
 * Two decisions that look loose and are not:
 *
 * **`X-Forwarded-Host` is read whatever `server.trustProxy` says.** That
 * setting governs which hop's *identity* is believed — the client address in
 * the audit trail and the rate limiter (`client-ip.ts`) — and believing a
 * forged one there means attributing an action to the wrong person. Here the
 * header only says which name the browser used to reach a server that is
 * answering the request anyway; the value is compared, never stored, never
 * emitted, and never used to build a URL (SEC-1 is untouched — every absolute
 * URL the IdP emits still derives from `server.baseUrl`). A caller who forges
 * it only gets to approve their own origin, and a caller who can set arbitrary
 * headers is not the caller CSRF protects against: they have no cookies.
 *
 * **The scheme is ignored** — both `https://host` and `http://host` are
 * returned. A TLS-terminating proxy that forwards over plain http and forgets
 * `X-Forwarded-Proto` is common enough that pinning the scheme would fail
 * exactly the deployments this exists for, and the difference it would buy is
 * an attacker who already controls http on the deployment's own hostname.
 *
 * An operator who wants the strict behavior back sets `server.trustedOrigins`
 * and nothing here is consulted.
 */

/** The browser-facing host, when something in front rewrote `Host`. */
const FORWARDED_HOST_HEADER = "x-forwarded-host"

/**
 * The origins that name the address this request arrived on, in both schemes.
 *
 * Empty for no request at all, which is what an `auth.api.*` call from our own
 * server code is: nobody chose an origin, so inventing one would trust a
 * request that was never made.
 */
export function requestOrigins(request?: Request): readonly string[] {
  if (!request) return []

  const hosts = new Set<string>()
  // A chain of proxies appends, so the leftmost entry is the one the browser
  // used — the opposite end from `X-Forwarded-For`'s rightmost-untrusted-hop
  // (`client-ip.ts`), because this header is a rewrite trail and that one is a
  // list of clients.
  const forwarded = normalizeHost(
    request.headers.get(FORWARDED_HOST_HEADER)?.split(",")[0]
  )
  if (forwarded) hosts.add(forwarded)
  // `Host`, or — for a `Request` built in-process rather than off a socket,
  // which is what `http/auth-proxy.ts` hands Better Auth — the host in its
  // URL. The two are the same value in a real request; the fallback only means
  // a synthetic one still resolves to the address it names.
  const host =
    normalizeHost(request.headers.get("host")) ??
    normalizeHost(new URL(request.url).host)
  if (host) hosts.add(host)

  return [...hosts].flatMap((value) => [`https://${value}`, `http://${value}`])
}

/**
 * A bare `host[:port]`, lower-cased, or `undefined` for anything else.
 *
 * Both headers are attacker-writable by a *direct* caller, so nothing that is
 * not a host may leave here. What goes out becomes an entry in Better Auth's
 * allow-list, and that list is matched as **patterns**: `*` and `?` are
 * wildcards there, so an `X-Forwarded-Host: *` would otherwise turn the check
 * off for that request, and `*.example.com` would hand it to anyone with a
 * subdomain. `URL` accepts both as hostnames — it has no opinion about a
 * wildcard — so they are refused here by name, before the round-trip.
 *
 * The round-trip through `URL` is the rest of the check: anything the parser
 * had to reinterpret (`evil.example/path`, `https://evil.example`, a value
 * with a space in it) comes back different and is refused. The IPv6 literal
 * `[::1]:3000` comes back unchanged, which is the form an `Origin` header
 * uses.
 */
function normalizeHost(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const candidate = value.trim().toLowerCase()
  if (candidate === "") return undefined
  if (candidate.includes("*") || candidate.includes("?")) return undefined
  try {
    return new URL(`https://${candidate}`).host === candidate
      ? candidate
      : undefined
  } catch {
    return undefined
  }
}

