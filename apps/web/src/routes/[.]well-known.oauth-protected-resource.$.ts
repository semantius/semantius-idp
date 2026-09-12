import { createFileRoute } from "@tanstack/react-router"

import {
  protectedResourcePreflight,
  protectedResourceResponse,
} from "@/server/oidc/protected-resource"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/.well-known/oauth-protected-resource/<path>` — RFC 9728 §3.1.
 *
 * The location the RFC *derives* for a resource with a path: the well-known
 * segment goes between the host and the resource's path, so
 * `https://host/rest` is documented at
 * `https://host/.well-known/oauth-protected-resource/rest`. Same body as the
 * root URL, which is the one the CLI reads; this exists so a client that
 * follows the derivation rather than the convention is not answered with a
 * 404 by a deployment that is otherwise working.
 *
 * A splat because the resource's path may have several segments, and the
 * router hands it over **decoded** (**D110**) — `findProtectedResource`
 * compares it whole, which is what makes that harmless.
 */
const handle = async ({
  request,
  params,
}: {
  request: Request
  params: { _splat?: string }
}) => protectedResourceResponse(await getRuntime(), request, params._splat ?? "")

export const Route = createFileRoute("/.well-known/oauth-protected-resource/$")(
  {
    server: {
      handlers: {
        GET: handle,
        OPTIONS: async ({ request }) =>
          protectedResourcePreflight(await getRuntime(), request),
      },
    },
  }
)
