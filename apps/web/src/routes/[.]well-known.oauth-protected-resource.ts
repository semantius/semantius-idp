import { createFileRoute } from "@tanstack/react-router"

import {
  protectedResourcePreflight,
  protectedResourceResponse,
} from "@/server/oidc/protected-resource"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/.well-known/oauth-protected-resource` (RFC 9728).
 *
 * The first hop of the discovery walk an MCP client and the `semantius` CLI
 * both make — protected-resource document, then the authorization server it
 * names. `server/oidc/protected-resource.ts` has the whole of the reasoning;
 * this file only binds it to a path.
 *
 * Like the RFC 8414 document, the URL clients actually fetch is the
 * **origin-root** one, which under a sub-path deployment sits above this app's
 * mount point and is therefore the reverse proxy's to route here
 * (`Caddyfile.subpath`). 404s until `oauth.protectedResources` names a
 * resource.
 */
export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        protectedResourceResponse(await getRuntime(), request),
      OPTIONS: async ({ request }) =>
        protectedResourcePreflight(await getRuntime(), request),
    },
  },
})
