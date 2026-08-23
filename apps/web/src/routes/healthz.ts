import { createFileRoute } from "@tanstack/react-router"

import { version } from "@/server/version"

/**
 * Liveness (OPS-3): the process is up and answering.
 *
 * Unauthenticated, non-revealing, and excluded from rate limiting and request
 * logging — a probe that gets throttled or floods the log is worse than no
 * probe. It deliberately touches neither the database nor the startup sequence:
 * liveness answers "should this container be restarted", and a database blip or
 * a still-running migration is not a reason to. Readiness is `/readyz`.
 */
export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { status: "ok", version },
          { headers: { "cache-control": "no-store" } }
        ),
    },
  },
})
