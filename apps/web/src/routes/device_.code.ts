import { createFileRoute } from "@tanstack/react-router"

import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { PROTOCOL_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/device/code` — RFC 8628's device authorization endpoint.
 *
 * Discovery advertises it here rather than under `/api/auth`, because the
 * rewrite that puts every provider endpoint at the issuer root moves this one
 * too; the route is what makes the advertised address answer. With
 * `oauth.deviceAuthorization.enabled` off the plugin is not registered and
 * the provider's own 404 comes back through unchanged — absent, not refused.
 *
 * `device_` rather than `device.`: the page at `/device` is a sibling, not a
 * layout this endpoint renders inside.
 *
 * **No CORS.** The client this grant exists for is a program with no browser;
 * a page that wanted a device code would be a page that wanted to hand one to
 * somebody else.
 */
export const Route = createFileRoute("/device_/code")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        forwardToAuth(await getRuntime(), request, {
          providerPath: PROTOCOL_ROUTES.deviceCode,
        }),
      GET: () =>
        new Response(null, {
          status: 405,
          headers: { allow: "POST", "cache-control": "no-store" },
        }),
    },
  },
})
