import { Suspense, lazy, useEffect, useRef, useState } from "react"

import { createFileRoute, notFound } from "@tanstack/react-router"

import { NativeSelect } from "@workspace/ui/components/native-select"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable"
import type { Table } from "@workspace/ui/components/schema-explorer"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"
import type {
  SQLExecutionContext,
  SQLResult,
  SQLRunnerHandle,
} from "@workspace/ui/components/sql-runner"

import { AdminShell } from "@/components/admin/admin-shell"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { adminHead } from "@/lib/page-title"
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
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.database, to: "/admin/database" },
      ]),
      schema: await fetchDatabaseSchema({ data: {} }),
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.database.title),
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

/** Tailwind's `lg`, which is where the two panes used to stop sitting side by side. */
const SIDE_BY_SIDE = 1024

/**
 * Whether the two panes fit beside each other (**D87**).
 *
 * The layout used to be `lg:grid-cols-…`, and a media query in CSS cannot
 * reach a prop. This is `use-mobile.ts`'s shape — the registry hook the
 * sidebar already runs on every page of both signed-in areas — for the same
 * reason it is: the server has no viewport, so the first paint is the
 * desktop one and a narrow browser corrects it on mount. **One group either
 * way, with only `orientation` changing**, so nothing unmounts when a window
 * crosses the breakpoint: two branches would remount CodeMirror and take the
 * operator's half-written statement with it.
 */
function useSideBySide() {
  const [wide, setWide] = useState(true)

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${String(SIDE_BY_SIDE)}px)`)
    const onChange = () => {
      setWide(query.matches)
    }
    query.addEventListener("change", onChange)
    onChange()
    return () => {
      query.removeEventListener("change", onChange)
    }
  }, [])

  return wide
}

function DatabasePage() {
  const { ui, schema: loaded } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const sideBySide = useSideBySide()
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
      // D87: the console is the page, so it takes the height the window has
      // left rather than the height its widest result happens to want, and
      // its one-sentence subtitle is not held to a paragraph's measure.
      fill
      wideDescription
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
        <p className="mb-4 shrink-0 text-sm text-muted-foreground">
          {t.admin.database.readWrite}
        </p>
      ) : null}

      {/* **A resizable group, not a grid** (D87). The tree column was
          `minmax(0,20rem)` and the two panes were fixed-height cards inside
          it: nothing followed the window, and the operator could not spend a
          wide screen on whichever half they were reading. The defaults are
          what the grid gave — 20 rem of tree — and the pixel `minSize`s are
          the point at which each pane stops being worth drawing. `min-w-0` on
          both panels for the reason it was on both grid children: the admin
          shell is `overflow-x-hidden` and a flex item's `min-width: auto`
          would let a wide result push its panel instead of scrolling inside
          the runner. */}
      <ResizablePanelGroup
        // **Stacked, it is allowed to be taller than the window.** Side by
        // side the group is exactly the space left below the heading and the
        // panes divide it. Stacked, that space has to hold the tree
        // *and* the whole console one under the other, and on a short narrow
        // window there is not enough of it: the editor was squeezed to its
        // three-row minimum on a fresh load at 900 x 800. Below `lg` — the
        // same 1024 px `SIDE_BY_SIDE` switches on — the group takes a
        // floor of 46 rem instead — 20 rem of tree, the separator, and a
        // console at its opening size — and `SidebarLayout`'s content box
        // scrolls to it.
        className="min-h-0 flex-1 max-lg:min-h-[46rem]"
        orientation={sideBySide ? "horizontal" : "vertical"}
      >
        <ResizablePanel
          className="flex min-h-0 min-w-0 flex-col gap-2"
          defaultSize={320}
          // The grid capped this column at `20rem` and gave every extra pixel
          // to the runner, which is still the right split (D84: a table name
          // and a column count do not want the width; a result grid does).
          // `preserve-pixel-size` is that cap, now movable.
          groupResizeBehavior="preserve-pixel-size"
          // **Capped only when the panes are stacked.** Side by side the
          // operator is free to give the tree as much width as they like.
          // Stacked, the group is a fixed 46 rem and the console below needs
          // the rest of it — and the orientation flips *after* hydration
          // (the server has no viewport), so the tree arrives carrying the
          // ratio it had as a column and would otherwise keep it.
          maxSize={sideBySide ? undefined : 320}
          minSize={200}
        >
          <Suspense
            fallback={<Skeleton className="min-h-0 flex-1 rounded-lg" />}
          >
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
              // The card is the pane; the notice below it, when there is one,
              // is what the `gap-2` on the panel is for.
              className="min-h-0 flex-1"
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
            <p className="shrink-0 text-xs text-muted-foreground">
              {t.admin.database.unavailable}
            </p>
          ) : null}
        </ResizablePanel>

        {/* The gap the grid's `gap-4` used to provide, given to the control
            that now sits in it. A `separator` reports *its own* orientation,
            which is the opposite of the group's — a row of panels is divided
            by a vertical line — so the horizontal arm is the stacked case. */}
        <ResizableHandle
          className="mx-2 aria-[orientation=horizontal]:mx-0 aria-[orientation=horizontal]:my-2"
          withHandle
        />

        <ResizablePanel
          className="flex min-h-0 min-w-0 flex-col gap-2"
          minSize={280}
        >
          <Suspense
            fallback={<Skeleton className="min-h-0 flex-1 rounded-lg" />}
          >
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
                : { mode: "read-write" as const })}
              // **After the spread, and merged rather than passed twice**
              // (D87). The `read-only` arm used to carry a `className` of its
              // own, so a second one written above the spread was silently
              // replaced: the card lost `flex-1`, stopped filling its panel,
              // and the editor and the grid — two panes of a group with no
              // height — rendered at zero. A prop that a conditional spread
              // may also set has to be resolved in one place.
              className={cn(
                "min-h-0 flex-1",
                !writable && "[&_fieldset]:hidden"
              )}
            />
          </Suspense>
          {truncatedRows === null ? null : (
            <p className="shrink-0 text-xs text-muted-foreground">
              {t.admin.database.truncated(truncatedRows)}
            </p>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </AdminShell>
  )
}
