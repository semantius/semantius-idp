import { createFileRoute } from "@tanstack/react-router"

import { corsFor, withCors } from "@/server/http/cors"
import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/.well-known/jwks.json` (FR-OIDC-16).
 *
 * Byte-identical to `/api/auth/jwks`, which keeps answering for anything that
 * already found it. This is the URL discovery advertises, because a verifier
 * caches `jwks_uri` for as long as the response allows and changing it later
 * is a breaking change for everything holding a token.
 */
export const Route = createFileRoute("/.well-known/jwks.json")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const runtime = await getRuntime()
        return withCors(
          await forwardToAuth(runtime, request, {
            providerPath: "/jwks",
          }),
          corsFor(request, runtime.config, "public")
        )
      },
    },
  },
})
