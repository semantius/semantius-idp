import { createFileRoute } from "@tanstack/react-router"

import { corsFor, preflightResponse, withCors } from "@/server/http/cors"
import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/** `{issuer}/oauth2/userinfo` (FR-OIDC-4, FR-OIDC-17). */
const handle = async ({ request }: { request: Request }) => {
  const runtime = await getRuntime()
  const cors = corsFor(request, runtime.config, "clients")
  return withCors(
    await forwardToAuth(runtime, request, {
      providerPath: "/oauth2/userinfo",
    }),
    cors
  )
}

export const Route = createFileRoute("/oauth2/userinfo")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      OPTIONS: async ({ request }) => {
        const runtime = await getRuntime()
        return preflightResponse(corsFor(request, runtime.config, "clients"))
      },
    },
  },
})
