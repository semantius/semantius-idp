import { Suspense, lazy, useEffect, useRef, useState } from "react"

import { createFileRoute, notFound } from "@tanstack/react-router"

import { NativeSelect } from "@workspace/ui/components/native-select"
import type { Table } from "@workspace/ui/components/schema-explorer"
import { Skeleton } from "@workspace/ui/components/skeleton"
import type {
  SQLExecutionContext,
  SQLResult,
  SQLRunnerHandle,
} from "@workspace/ui/components/sql-runner"

import { AdminShell } from "@/components/admin/admin-shell"
import { getCatalog } from "@/server/i18n"
import type { AdminDatabaseSchema } from "@/server/functions/admin"
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
    return { ui: context.ui, schema: await fetchDatabaseSchema({ data: {} }) }
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

/**
 * Quotes a Postgres identifier — `"` doubled, the same rule
 * `server/db/client.ts` applies. Copied rather than imported because that
 * module reaches the `postgres` driver, and this file is client code that
 * `check-client-bundle.ts` would fail for carrying it.
 */
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`

function DatabasePage() {
  const { ui, schema: loaded } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  // `SQLResult` has no truncation flag, so the caption is the page's job.
  const [truncatedRows, setTruncatedRows] = useState<number | null>(null)
  /**
   * The selector's answer, once the operator has used it (D84), and `null`
   * until then — the loader's document is what the page opens on. An override
   * rather than state seeded from the loader: seeded state would go stale the
   * moment the route was invalidated, and this way there is one source of
   * truth per state of the page rather than two that can disagree.
   */
  const [picked, setPicked] = useState<AdminDatabaseSchema | null>(null)
  /** The schema being fetched. Non-null only while one is in flight. */
  const [pending, setPending] = useState<string | null>(null)
  const [switchFailed, setSwitchFailed] = useState(false)
  // Named `sql` rather than `query`: `onExecute` below takes a parameter
  // called `query`, and one name for two things in one component is how the
  // wrong one gets read.
  const [sql, setSql] = useState("")
  /**
   * The runner's handle in *state*, through a callback ref, not `useRef`.
   *
   * Both panes are `React.lazy`, and the tree arrives first — it is 25 kB
   * against the editor's 830. A run button clicked in that window found
   * `ref.current` still null and typed a statement that never ran; the e2e
   * suite caught it on a loaded machine, and a slow connection is the same
   * window made wider. State re-renders when the runner mounts, so the effect
   * below runs again and the request is honoured late rather than dropped.
   */
  const [runner, setRunner] = useState<SQLRunnerHandle | null>(null)
  /**
   * A counter, not a flag. Two clicks on the same table's run button are two
   * runs, and a second `true` is not a change an effect re-fires for.
   */
  const [runRequests, setRunRequests] = useState(0)
  /** The last request actually executed, so none of them runs twice. */
  const lastRun = useRef(0)

  useEffect(() => {
    // **Through an effect, and that is the load-bearing part.** `run()` reads
    // the editor's current value, and `setSql` in the click handler has not
    // reached the runner as a prop until this commit — called inline, the run
    // button would execute whatever statement the editor held *before* it was
    // clicked.
    if (runRequests > lastRun.current && runner) {
      lastRun.current = runRequests
      runner.run()
    }
  }, [runRequests, runner])

  const schema = picked ?? loaded

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

  /**
   * Fetch another schema's tree (D84).
   *
   * The endpoint is the same one the loader used, so a switch costs one round
   * trip and no navigation: the URL does not carry the schema, because the
   * statement in the editor beside it would not survive the reload.
   */
  const onSchemaChange = async (name: string) => {
    setPending(name)
    setSwitchFailed(false)
    try {
      const next = await fetchDatabaseSchema({ data: { schema: name } })
      // `null` is a 4xx from the endpoint — a schema dropped between the
      // listing and the click, or the console turned off under us. The tree
      // that is already drawn stays; emptying it would lose the operator's
      // place to say something they can read in one line.
      if (next) setPicked(next)
      else setSwitchFailed(true)
    } finally {
      setPending(null)
    }
  }

  /**
   * The run button on a table row (D84).
   *
   * **Schema-qualified on purpose.** The search path is the *deployment's*
   * schema, so `select * from "user"` reads `idp.user` whatever the tree is
   * showing — which is right until the selector points somewhere else, and
   * then it is silently the wrong table or none at all.
   */
  const onTableAction = (table: Table) => {
    const target = `${quoted(table.schema ?? schema.schemaName)}.${quoted(table.name)}`
    setSql(`select * from ${target} limit 100`)
    setRunRequests((count) => count + 1)
  }

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
      // The mode is in the opening sentence rather than a paragraph of its
      // own beneath it (D84): a `read-only` console says so where the page
      // introduces itself, and a writable one keeps the line below, which is
      // an instruction rather than a restatement.
      description={
        writable
          ? t.admin.database.description
          : t.admin.database.descriptionReadOnly
      }
    >
      {writable ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {t.admin.database.readWrite}
        </p>
      ) : null}

      {/* The tree column is capped rather than proportional. `2fr_3fr` gave it
          40 % of a wide screen for content that is a table name and a column
          count -- the runner is where the width is worth spending, and it is
          the half that has to hold a result grid. `min-w-0` on both children:
          the admin shell is `overflow-x-hidden` and a grid child defaults to
          `min-width: auto`, so a wide result would push its column instead of
          scrolling inside the runner. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-2">
          <Suspense fallback={<Skeleton className="h-96 w-full rounded-lg" />}>
            {/* **The selector *is* the card's header line** (D84, second
                pass). It sat above the card at first, under its own label,
                with the header showing the database name beside a "/ to
                search" hint — a strip 20rem wide, and every pixel of it
                decorative: the name is on the runner beside it, and the
                search field the hint names is permanently visible one row
                below. The header is the control now, the table count keeps
                its place, and the label is the select's own `aria-label`
                because a visible one would cost the width the control
                needs. */}
            <SchemaExplorer
              isLoading={pending !== null}
              onTableAction={onTableAction}
              tableActionLabel={(table) => t.admin.database.preview(table.name)}
              tables={schema.tables}
              // Not drawn -- `titleSlot` takes the header line -- but the
              // tree's own `aria-label` is built from it, and "public
              // database schema" is what the default would have announced.
              title={schema.schemaName}
              titleSlot={
                <NativeSelect
                  aria-label={t.admin.database.schema}
                  className="w-full"
                  disabled={pending !== null}
                  onChange={(event) => void onSchemaChange(event.target.value)}
                  size="sm"
                  value={pending ?? schema.schemaName}
                >
                  {schema.schemas.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </NativeSelect>
              }
            />
          </Suspense>
          {switchFailed ? (
            <p className="text-xs text-muted-foreground">
              {t.admin.database.unavailable}
            </p>
          ) : null}
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
              onExecute={onExecute}
              onValueChange={setSql}
              ref={setRunner}
              title={t.admin.database.runner}
              value={sql}
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
