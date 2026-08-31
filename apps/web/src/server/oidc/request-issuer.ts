/**
 * The issuer one request should be answered with (`server.dynamicIssuer`).
 *
 * With the flag **off** — the default — this returns the boot issuer,
 * `${base.origin}${base.basePath}`, unconditionally: SEC-1 exactly as it has
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
}

/**
 * The issuer for this request: per-host under `dynamicIssuer`, the boot
 * issuer otherwise — and the boot issuer again whenever no header survives
 * {@link normalizeHost}.
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

  if (!host) return bootIssuer

  const scheme = base.secure ? "https" : "http"
  return `${scheme}://${host}${base.basePath}`
}

function safeUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
