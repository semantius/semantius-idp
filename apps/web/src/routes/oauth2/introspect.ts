import { createFileRoute } from "@tanstack/react-router"

import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/oauth2/introspect` (FR-OIDC-4, FR-OIDC-17).
 *
 * **No CORS, deliberately.** Introspection is a resource-server endpoint,
 * called server-to-server with the caller's own client credentials. A browser
 * has no business here, and an allow-origin header would only be useful to an
 * attacker who had already got a client secret into a page.
 */
export const Route = createFileRoute("/oauth2/introspect")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        forwardToAuth(await getRuntime(), request, {
          providerPath: "/oauth2/introspect",
        }),
      /**
       * 405 rather than the app's HTML: without a handler the router falls
       * through to the page tree and a GET gets a 200 with a sign-in page.
       */
      GET: () =>
        new Response(null, {
          status: 405,
          headers: { allow: "POST", "cache-control": "no-store" },
        }),
    },
  },
})
