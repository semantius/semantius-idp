import { createFileRoute } from "@tanstack/react-router"

import { proxyGatewayRequest } from "@/server/gateways/proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `/gateway/<name>/<rest>` — everything below the upstream's root
 * (FR-GW-3, **D91**).
 *
 * See `$name.ts` for why there are two files and why all seven methods are
 * declared on each of them.
 */
const handle = async ({
  request,
  params,
}: {
  request: Request
  params: { name: string; _splat?: string }
}) =>
  proxyGatewayRequest(await deps(), request, params.name, params._splat ?? "")

async function deps() {
  const runtime = await getRuntime()
  return {
    config: runtime.config,
    auth: runtime.auth,
    database: runtime.database,
    logger: runtime.logger,
  }
}

export const Route = createFileRoute("/gateway/$name/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      OPTIONS: handle,
      HEAD: handle,
    },
  },
})
