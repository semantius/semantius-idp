import { createFileRoute } from "@tanstack/react-router"

import { migrationsAreCurrent } from "@/server/db/migrate"
import { getRuntime } from "@/server/runtime"
import { version } from "@/server/version"

/**
 * Readiness (OPS-3): config loaded, database reachable, migrations current,
 * signing key present.
 *
 * Building the runtime *is* the OPS-2 sequence, so awaiting it here is the
 * honest readiness signal: a boot that is still migrating reports not-ready
 * rather than a half-answer.
 *
 * Unauthenticated and non-revealing: the body names which check failed, because
 * an operator needs that, but never why in a way that leaks a hostname, a
 * connection string or a stack trace.
 */
export const Route = createFileRoute("/readyz")({
  server: {
    handlers: {
      GET: async () => {
        const checks: Record<string, boolean> = {
          config: false,
          database: false,
          migrations: false,
          signingKey: false,
        }

        try {
          const runtime = await getRuntime()
          checks.config = true

          await runtime.database.sql`select 1`
          checks.database = true

          checks.migrations = await migrationsAreCurrent(runtime.database)

          const keys = await runtime.database.db
            .select({ id: runtime.database.schema.jwks.id })
            .from(runtime.database.schema.jwks)
            .limit(1)
          checks.signingKey = keys.length > 0
        } catch {
          // Leave the remaining checks false; the body says which.
        }

        const ready = Object.values(checks).every(Boolean)
        return Response.json(
          { status: ready ? "ready" : "not-ready", version, checks },
          {
            status: ready ? 200 : 503,
            headers: { "cache-control": "no-store" },
          }
        )
      },
    },
  },
})
