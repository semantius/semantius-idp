import { createFileRoute } from "@tanstack/react-router"

import { migrationsAreCurrent } from "@/server/db/migrate"
import { isDraining } from "@/server/http/lifecycle"
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
 *
 * A draining process answers not-ready *before* any check runs (OPS-4). The
 * checks would all still pass — the pool is open and the migrations are
 * current, right up until the moment they are not — and answering 200 for
 * those last seconds is exactly how a rolling deploy sends requests to a
 * container that is on its way out.
 */
export const Route = createFileRoute("/readyz")({
  server: {
    handlers: {
      GET: async () => {
        if (isDraining()) {
          return Response.json(
            { status: "draining", version },
            { status: 503, headers: { "cache-control": "no-store" } }
          )
        }

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
