/**
 * The issuer one request should be answered with (`server.dynamicIssuer`).
 *
 * With the flag **off** — the default — this returns the boot issuer,
 * `${base.origin}${base.basePath}`, unconditionally: the base-URL rule exactly as it has
 * always been, whatever headers the request carries.
 *
 * With the flag **on**, the issuer follows the host the request arrived on.
 * Turning it on is the operator's assertion about the ingress (the config
 * schema spells out the four conditions); this module's own job is narrower —
 * never emit anything that is not a host:
 *
 *  - the host candidates go through {@link normalizeHost}, the same gate the
 *    CSRF origin check trusts, so `*`, `?`, a smuggled path or credentials,
 *    unicode and whitespace are all refused (the fallback is then the boot
 *    issuer, never a partial value);
 *  - the **scheme comes from `base.secure`** — the scheme of `server.baseUrl`
 *    — never from the inbound request. A forwarded `X-Forwarded-Proto` is one
 *    more attacker-writable header this deliberately does not read.
 *
 * Precedence mirrors `http/request-origin.ts`: the leftmost `X-Forwarded-Host`
 * when a proxy is trusted at all (`trustProxy !== false`), then `Host`, then
 * the host in the request URL (which is what a `Request` built in-process
 * carries). The mount path always stays `base.basePath` — the deployment moves
 * hosts, not mount points.
 */

import type { BasePathInfo } from "../config/derive"
import { normalizeHost } from "../http/request-origin"

/** The browser-facing host, when something in front rewrote `Host`. */
const FORWARDED_HOST_HEADER = "x-forwarded-host"

export interface RequestIssuerOptions {
  /** `server.trustProxy` — gates whether `X-Forwarded-Host` is read at all. */
  trustProxy: boolean | readonly string[]
  /**
   * `server.allowedHosts` — the hosts the flag may follow. Absent
   * means every one, which is what the flag did before the list existed.
   */
  allowedHosts?: readonly string[]
}

/**
 * The issuer for this request: per-host under `dynamicIssuer`, the boot
 * issuer otherwise — and the boot issuer again whenever no header survives
 * {@link normalizeHost}, or the host that did is not on `allowedHosts`.
 */
export function resolveRequestIssuer(
  base: BasePathInfo,
  request: Request,
  options: RequestIssuerOptions
): string {
  const bootIssuer = `${base.origin}${base.basePath}`
  if (!base.dynamicIssuer) return bootIssuer

  // A chain of proxies appends, so the leftmost entry is the one the browser
  // used — same reading as `requestOrigins`.
  const forwarded =
    options.trustProxy !== false
      ? normalizeHost(
          request.headers.get(FORWARDED_HOST_HEADER)?.split(",")[0]
        )
      : undefined

  const host =
    forwarded ??
    normalizeHost(request.headers.get("host")) ??
    normalizeHost(safeUrlHost(request.url))

  // A host outside the list is answered as the boot issuer, not refused: the
  // request is still served, on the canonical name, exactly as one that
  // carried no usable host at all. A refusal here would be a 4xx on every
  // path for a hostname the operator simply forgot to list.
  if (!host || !hostAllowed(host, options.allowedHosts)) return bootIssuer

  const scheme = base.secure ? "https" : "http"
  return `${scheme}://${host}${base.basePath}`
}

/**
 * Whether a resolved host is one `dynamicIssuer` may answer as.
 *
 * An entry is an exact host or a `*.` suffix pattern. The suffix matches at a
 * label boundary — `*.example.com` takes `a.example.com` and `a.b.example.com`
 * and neither `example.com` nor `notexample.com`. A port on the entry must be
 * matched by the request; an entry without one matches whatever port the
 * request carries, because the same deployment is `:443` from the internet
 * and `:8443` from a test harness.
 */
export function hostAllowed(
  host: string,
  allowedHosts: readonly string[] | undefined
): boolean {
  if (allowedHosts === undefined) return true
  const [hostname, port] = splitHostPort(host.toLowerCase())
  return allowedHosts.some((entry) => {
    const [pattern, patternPort] = splitHostPort(entry.toLowerCase())
    if (patternPort !== undefined && patternPort !== port) return false
    if (!pattern.startsWith("*.")) return hostname === pattern
    const suffix = pattern.slice(1)
    return hostname.length > suffix.length && hostname.endsWith(suffix)
  })
}

/** `host[:port]` → `[host, port?]`, bracketed IPv6 included. */
function splitHostPort(value: string): [string, string | undefined] {
  const match = /^(\[[^\]]*\]|[^:]+)(?::(\d{1,5}))?$/.exec(value)
  return match ? [match[1]!, match[2]] : [value, undefined]
}

function safeUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
