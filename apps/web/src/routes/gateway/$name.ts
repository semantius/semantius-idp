import { createFileRoute } from "@tanstack/react-router"

import { proxyGatewayRequest } from "@/server/gateways/proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `/gateway/<name>` — the upstream's own root (FR-GW-3, **D91**).
 *
 * The sibling `$name.$.ts` handles everything below it. Two files rather than
 * one because TanStack's splat only matches when there *is* a rest, and a
 * gateway whose upstream answers at its root would otherwise 404.
 *
 * **All seven methods are declared on both**, and that is not tidiness: an
 * undeclared method falls through to the page tree, which answers 200 with the
 * sign-in document. A client that sent `DELETE` would get an HTML page and a
 * success status — the lesson `/oauth2/token` taught, and the reason the
 * unit suite asserts the method list on both files.
 */
const handle = async ({
  request,
  params,
}: {
  request: Request
  params: { name: string }
}) =>
  proxyGatewayRequest(await deps(), request, params.name, "")

async function deps() {
  const runtime = await getRuntime()
  return {
    config: runtime.config,
    auth: runtime.auth,
    database: runtime.database,
    logger: runtime.logger,
  }
}

export const Route = createFileRoute("/gateway/$name")({
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
