import { Suspense, lazy, useState } from "react"

import { createFileRoute, notFound } from "@tanstack/react-router"

import { Skeleton } from "@workspace/ui/components/skeleton"
import type {
  SQLExecutionContext,
  SQLResult,
} from "@workspace/ui/components/sql-runner"

import { AdminShell } from "@/components/admin/admin-shell"
import { getCatalog } from "@/server/i18n"
import {
  executeDatabaseQuery,
  fetchDatabaseSchema,
} from "@/server/functions/admin"

/**
 * `/admin/database` — the schema, and a SQL console (FR-ADMIN-7).
 *
 * Off by default and absent when it is off: `admin.database` at `disabled`
 * takes the nav entry, this route and both endpoints with it. The endpoints go
 * because the owner asked for it explicitly — a deployment that has turned the
 * console off must not have the API either — and this route 404s rather than
 * 403s for the same reason `/account/api-keys` does when API keys are off.
 *
 * **The server is the only authority on what may run.** `read` opens a
 * `BEGIN READ ONLY`, so Postgres refuses a write wherever it hides; the
 * component's own keyword guard is a convenience its documentation is explicit
 * about not being a boundary. Everything else — the 10 s statement timeout,
 * the 500-row cap, the per-cell cap, the audit row — is in
 * `server/admin/database.ts` and reachable identically with an admin API key.
 */
export const Route = createFileRoute("/admin/database")({
  loader: async ({ context }) => {
    // FR-ADMIN-7: with the console off there is no page, not a hidden panel.
    if (!context.ui.adminDatabaseEnabled) throw notFound()
    return { ui: context.ui, schema: await fetchDatabaseSchema() }
  },
  component: DatabasePage,
})

/**
 * **The first `React.lazy` in this tree, and the reason is the bundle gate.**
 *
 * `check-client-bundle.ts` sums *all* client JavaScript, so route-level code
 * splitting alone does not keep CodeMirror out of the total — it only keeps it
 * out of the first paint. The ceiling had to rise either way. What the
 * explicit dynamic import buys is that a deployment's ordinary visitors — who
 * never see `/admin`, let alone this page — do not download ~400 kB of SQL
 * editor, and that it stays true if the router's code-splitting configuration
 * ever changes underneath us.
 */
const SchemaExplorer = lazy(async () => ({
  default: (await import("@workspace/ui/components/schema-explorer"))
    .SchemaExplorer,
}))

const SQLRunner = lazy(async () => ({
  default: (await import("@workspace/ui/components/sql-runner")).SQLRunner,
}))

function DatabasePage() {
  const { ui, schema } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  // `SQLResult` has no truncation flag, so the caption is the page's job.
  const [truncatedRows, setTruncatedRows] = useState<number | null>(null)

  if (!schema) {
    return (
      <AdminShell title={t.admin.database.title}>
        <p className="text-sm text-muted-foreground">
          {t.admin.database.unavailable}
        </p>
      </AdminShell>
    )
  }

  const writable = schema.mode === "read-write"

  const onExecute = async (
    query: string,
    context: SQLExecutionContext
  ): Promise<SQLResult> => {
    setTruncatedRows(null)
    // **The requested mode is not the displayed one on a `read-only`
    // deployment.** The runner is pinned to `read-write` there so its own
    // keyword guard never fires and the statement actually reaches the server
    // (see the comment beside `SQLRunner` below) -- but the *request* must
    // still say `read`, or the endpoint refuses it with `WRITE_NOT_ALLOWED`
    // before running anything and every query, `select 1` included, comes back
    // as a refusal. Found by the e2e suite, which is the only gate that drives
    // the real component.
    const outcome = await executeDatabaseQuery({
      data: { query, mode: writable ? context.mode : "read" },
      signal: context.signal,
    })
    if (!outcome) throw new Error(t.admin.database.unavailable)

    if (!outcome.ok) {
      // The component rebuilds a CodeMirror diagnostic from exactly these
      // fields (`toRunnerError`), so the failure has to arrive as a *thrown*
      // Error carrying them rather than as a returned value. `sqlstate` maps
      // to `code`, which is what the error panel prints beside the message.
      throw Object.assign(new Error(outcome.error.message), {
        code: outcome.error.sqlstate ?? outcome.error.code,
        detail: outcome.error.detail,
        hint: outcome.error.hint,
        line: outcome.error.line,
        column: outcome.error.column,
      })
    }

    if (outcome.truncated) setTruncatedRows(outcome.rows.length)
    return {
      rows: outcome.rows,
      fields: outcome.fields,
      rowCount: outcome.rowCount,
      command: outcome.command,
      durationMs: outcome.durationMs,
    }
  }

  return (
    <AdminShell
      title={t.admin.database.title}
      description={t.admin.database.description}
    >
      <p className="mb-4 text-sm text-muted-foreground">
        {writable ? t.admin.database.readWrite : t.admin.database.readOnly}
      </p>

      {/* `min-w-0` on both children: the admin shell is `overflow-x-hidden`,
          and a grid child defaults to `min-width: auto`, so a wide result
          would push the column instead of scrolling inside the runner. */}
      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <div className="min-w-0">
          <Suspense fallback={<Skeleton className="h-96 w-full rounded-lg" />}>
            <SchemaExplorer tables={schema.tables} title={schema.schemaName} />
          </Suspense>
        </div>
        <div className="min-w-0">
          <Suspense fallback={<Skeleton className="h-96 w-full rounded-lg" />}>
            {/* A `read-only` deployment gets the runner pinned to
                `read-write` with its mode fieldset hidden — which reads
                backwards and is deliberate. With the mode controlled to
                `read`, the component's own keyword guard intercepts a write
                before it is sent and offers an "Enable writes" button that a
                controlled prop makes permanently inert: a dead control on
                every write attempt. Pinned the other way, the guard never
                fires, the statement reaches the server, and the READ ONLY
                transaction refuses it with a precise `25006` on the right
                line — which is the error the operator can act on. The server
                is the authority in both cases; only one of them says so
                usefully. The pin is a *display* choice and stops here:
                `onExecute` above sends `read` regardless, because the endpoint
                refuses a requested `read-write` on a `read-only` deployment.
                Recorded as D83. */}
            <SQLRunner
              database={schema.database}
              title={t.admin.database.runner}
              onExecute={onExecute}
              {...(writable
                ? { defaultMode: "read" as const }
                : {
                    mode: "read-write" as const,
                    className: "[&_fieldset]:hidden",
                  })}
            />
          </Suspense>
          {truncatedRows === null ? null : (
            <p className="mt-2 text-xs text-muted-foreground">
              {t.admin.database.truncated(truncatedRows)}
            </p>
          )}
        </div>
      </div>
    </AdminShell>
  )
}
