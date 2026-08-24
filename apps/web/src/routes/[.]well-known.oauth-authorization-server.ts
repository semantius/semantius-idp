import { createFileRoute } from "@tanstack/react-router"

import { corsFor, withCors } from "@/server/http/cors"
import { forwardDiscovery } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/.well-known/oauth-authorization-server` (RFC 8414, FR-OIDC-15).
 *
 * The OAuth-flavoured twin of the OIDC document. Some clients look only here.
 *
 * RFC 8414 also defines an **origin-root** form for an issuer with a path
 * (`/.well-known/oauth-authorization-server/idp`). That one cannot be a route
 * of this app — it lives above the mount point — so it is Caddy's, and M12's
 * `Caddyfile.subpath` adds it.
 */
export const Route = createFileRoute("/.well-known/oauth-authorization-server")(
  {
    server: {
      handlers: {
        GET: async ({ request }) => {
          const runtime = await getRuntime()
          return withCors(
            await forwardDiscovery(
              runtime,
              request,
              "/.well-known/oauth-authorization-server"
            ),
            corsFor(request, runtime.config, "public")
          )
        },
      },
    },
  }
)
