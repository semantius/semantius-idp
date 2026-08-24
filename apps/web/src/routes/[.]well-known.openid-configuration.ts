import { createFileRoute } from "@tanstack/react-router"

import { corsFor, preflightResponse, withCors } from "@/server/http/cors"
import { forwardDiscovery } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/.well-known/openid-configuration` (FR-OIDC-15, FR-OIDC-17).
 *
 * Public and readable from anywhere: every client has to fetch this before it
 * can do anything, and restricting it protects nothing.
 *
 * The proxy rewrites the endpoint URLs to the issuer root and refuses to serve
 * a document whose `issuer` is not byte-equal to `server.baseUrl` — a mismatch
 * there is the single most common cause of a client library failing with an
 * unhelpful message.
 */
const handle = async ({ request }: { request: Request }) => {
  const runtime = await getRuntime()
  return withCors(
    await forwardDiscovery(
      runtime,
      request,
      "/.well-known/openid-configuration"
    ),
    corsFor(request, runtime.config, "public")
  )
}

export const Route = createFileRoute("/.well-known/openid-configuration")({
  server: {
    handlers: {
      GET: handle,
      OPTIONS: async ({ request }) =>
        preflightResponse(
          corsFor(request, (await getRuntime()).config, "public")
        ),
    },
  },
})
