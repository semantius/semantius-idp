/**
 * Per-request expansion of `{host}` redirect templates (`server.dynamicIssuer`).
 *
 * A client registered with `https://{host}/oauth2_callback` should match the
 * callback on every host the edge routes. The rows **store the template
 * verbatim** — reconcile and the admin endpoints write what was configured —
 * and the expansion happens at read time, through the oauth-provider's
 * client-discovery extension point: `getClient()` sees `clientDiscoveryId` on
 * the row and hands it to {@link resolve}, which substitutes the host the
 * current request resolved to (`currentRequestIssuer()`).
 *
 * Why this seam and not a rewrite at reconcile time: the set of hosts is not
 * known at boot — that is the whole premise — and the provider's own cache
 * discipline already fits: a row carrying a `clientDiscoveryId` is never
 * served from the trusted-client cache and never written back to it
 * (`utils-*.mjs` `getClient`), so one host's expansion cannot leak to another.
 *
 * The expansion covers `postLogoutRedirectUris` as well as `redirectUris`:
 * `getRegisteredLogoutRedirect` is an exact `includes`, so an unexpanded
 * template there would fail closed and RP-initiated logout would break
 * silently. Outside a request — or when the request resolved no usable host —
 * template entries are DROPPED rather than passed through: an exact match can
 * never hit a literal `{host}`, and handing the provider a URI no browser can
 * be sent to helps nobody.
 */

import { extendOAuthProvider } from "@better-auth/oauth-provider"

import { expandHostTemplate, hasHostTemplate } from "../../lib/client-rules"
import { currentRequestIssuer } from "../http/request-log"

/**
 * Persisted as the row's `clientDiscoveryId`. Changing it orphans every row
 * that carries it — the provider then resolves those clients to nothing — so
 * it is a wire-format constant, not a name to tidy.
 */
export const HOST_TEMPLATE_DISCOVERY_ID = "host-template"

/** The host of the issuer the current request resolved to, if any. */
function currentRequestHost(): string | undefined {
  const issuer = currentRequestIssuer()
  if (!issuer) return undefined
  try {
    return new URL(issuer).host
  } catch {
    return undefined
  }
}

function expandUris(
  uris: readonly string[] | null | undefined,
  host: string | undefined
): string[] {
  if (!uris) return []
  return uris.flatMap((uri) => {
    if (!hasHostTemplate(uri)) return [uri]
    return host ? [expandHostTemplate(uri, host)] : []
  })
}

interface TemplateClientRow {
  redirectUris: string[]
  postLogoutRedirectUris?: string[] | null
}

/** Exported for the unit test; the runtime path goes through `getClient()`. */
export function expandTemplateClient<T extends TemplateClientRow>(
  client: T,
  host: string | undefined = currentRequestHost()
): T {
  return {
    ...client,
    redirectUris: expandUris(client.redirectUris, host),
    postLogoutRedirectUris: expandUris(client.postLogoutRedirectUris, host),
  }
}

/**
 * One module-level extension object, so re-running a plugin `init()` against
 * the same provider registers nothing twice (`extendOAuthProvider` dedupes by
 * identity).
 */
const hostTemplateExtension = {
  clientDiscovery: {
    id: HOST_TEMPLATE_DISCOVERY_ID,
    // Cheap by contract. `true` for every client id is correct here: for a
    // row that carries our discovery id the provider requires a match, and
    // for an id with no row at all `resolve(…, null)` answers null — this
    // discovery never invents clients.
    matches: () => true,
    resolve: (
      _ctx: unknown,
      _clientId: string,
      existing: TemplateClientRow | null
    ) => {
      if (!existing) return null
      return expandTemplateClient(existing)
    },
  },
}

/**
 * Registers the discovery with the oauth-provider plugin. Called from the idp
 * plugin's `init()`, which is the documented seam for extension registration.
 */
export function registerHostTemplateDiscovery(ctx: {
  getPlugin: (id: string) => unknown
}): void {
  extendOAuthProvider(
    ctx as Parameters<typeof extendOAuthProvider>[0],
    hostTemplateExtension as Parameters<typeof extendOAuthProvider>[1]
  )
}
