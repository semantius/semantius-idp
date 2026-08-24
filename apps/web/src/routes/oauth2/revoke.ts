import { createFileRoute } from "@tanstack/react-router"

import { corsFor, preflightResponse, withCors } from "@/server/http/cors"
import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/oauth2/revoke` (FR-OIDC-4, FR-OIDC-17, RFC 7009).
 *
 * The proxy normalises the one case the provider gets wrong: an unknown token
 * is a success, so the endpoint cannot be used to discover which tokens exist.
 */
export const Route = createFileRoute("/oauth2/revoke")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const cors = corsFor(request, runtime.config, "clients")
        return withCors(
          await forwardToAuth(runtime, request, {
            providerPath: "/oauth2/revoke",
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
