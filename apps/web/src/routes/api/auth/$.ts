import { createFileRoute } from "@tanstack/react-router"

import { getRuntime } from "@/server/runtime"

/**
 * Better Auth's own endpoints, mounted at `{baseUrl}/api/auth/*` (§3).
 *
 * The protocol endpoints OIDC clients discover — `/oauth2/*` and
 * `/.well-known/*` — live at the issuer root instead and are separate thin
 * routes that delegate to the same handler (FR-OIDC-4/15).
 */
const handle = async ({ request }: { request: Request }) =>
  (await getRuntime()).auth.handler(request)

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      OPTIONS: handle,
    },
  },
})
