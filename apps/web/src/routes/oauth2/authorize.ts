import { createFileRoute } from "@tanstack/react-router"

import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/oauth2/authorize` (FR-OIDC-4).
 *
 * The authorization endpoint has to be at the issuer root because that is what
 * discovery advertises and what every client hard-codes. No CORS headers: an
 * authorization request is a *navigation*, not a fetch — a browser follows it
 * as a top-level redirect, and a page that could read the response would be
 * reading an authorization code.
 */
const handle = async ({ request }: { request: Request }) =>
  forwardToAuth(await getRuntime(), request, {
    providerPath: "/oauth2/authorize",
  })

export const Route = createFileRoute("/oauth2/authorize")({
  server: { handlers: { GET: handle, POST: handle } },
})
