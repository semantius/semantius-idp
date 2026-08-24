import { createFileRoute } from "@tanstack/react-router"

import { corsFor, preflightResponse, withCors } from "@/server/http/cors"
import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/oauth2/token` (FR-OIDC-4, FR-OIDC-17).
 *
 * Browser-based public clients call this directly, so it carries CORS for the
 * origins the deployment registered redirect URIs for — and for nobody else.
 */
export const Route = createFileRoute("/oauth2/token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const cors = corsFor(request, runtime.config, "clients")
        return withCors(
          await forwardToAuth(runtime, request, {
            providerPath: "/oauth2/token",
          }),
          cors
        )
      },

      /**
       * A protocol endpoint that only takes POST answers 405, not the app's
       * HTML. Without this the router falls through to the page tree and a
       * client doing a GET gets a 200 with a sign-in page in it.
       */
      GET: () =>
        new Response(null, {
          status: 405,
          headers: { allow: "POST, OPTIONS", "cache-control": "no-store" },
        }),
      OPTIONS: async ({ request }) => {
        const runtime = await getRuntime()
        return preflightResponse(corsFor(request, runtime.config, "clients"))
      },
    },
  },
})
