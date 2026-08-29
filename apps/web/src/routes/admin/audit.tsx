import { Link, createFileRoute } from "@tanstack/react-router"

import { buttonVariants } from "@workspace/ui/components/button"
import { Card } from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@workspace/ui/components/empty"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { NativeSelect } from "@workspace/ui/components/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

import { AdminShell } from "@/components/admin/admin-shell"
import { searchString } from "@/lib/search-params"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { adminHead } from "@/lib/page-title"
import { getCatalog } from "@/server/i18n"
import type { Catalog } from "@/server/i18n"
import { fetchAuditPage } from "@/server/functions/admin"
import type { AdminAuditRow } from "@/server/functions/admin"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { LocalTime } from "@/components/common/local-time"

/**
 * `/admin/audit` — the trail (SEC-6).
 *
 * Paged by cursor rather than by page number, and the "older events" link
 * carries the timestamp of the last row shown. An offset walk over a table
 * that only grows at the head repeats and skips rows as new events land
 * between clicks, which in an audit log is not a cosmetic problem: it is a
 * missing event in an investigation.
 *
 * `metadata` is printed as raw JSON on purpose. It is written by a dozen
 * different call sites, and any attempt to render it prettily would either
 * drop fields or invent structure that is not there.
 *
 * **Who** and **what** are resolved to names (item 13). Both columns used to
 * show the first eight characters of a UUID: enough to tell two rows apart and
 * not enough to tell *anyone* anything, so reading the trail meant copying an
 * id into the user search for every line. The target column showed the id with
 * no type at all — `targetType` was fetched and never rendered — so a row
 * about an API key and a row about a user looked identical. The full ids are
 * still there, in the `title` of each cell, because an id is what you paste
 * into a query.
 */
export const Route = createFileRoute("/admin/audit")({
  /**
   * The loader re-runs when the search changes.
   *
   * **Without `loaderDeps` it does not**, and that is not a subtlety: every
   * control on this page is a link or a GET form, so "the state of the screen is
   * the URL" only holds if a new URL re-reads the data. A form submits as a real
   * navigation and looked fine; the pagination links are client-side, so Next
   * moved the URL to `page=2` and left page one on the screen. Pagination did
   * nothing at all, and nothing could see it — a loader with no declared
   * dependency is cached against the *route*, not the query.
   */
  loaderDeps: ({ search }) => search as Record<string, unknown>,
  loader: async ({ context, deps }) => {
    const search = deps
    const query = {
      action: searchString(search.action),
      outcome: searchString(search.outcome),
      actorUserId: searchString(search.actorUserId),
      targetId: searchString(search.targetId),
      before: searchString(search.before),
    }
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.audit, to: "/admin/audit" },
      ]),
      query,
      page: await fetchAuditPage({ data: query }),
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.audit.title),
  component: AuditPage,
})

const OUTCOMES = ["success", "failure", "denied"] as const

function AuditPage() {
  const { ui, query, page } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  if (!page) return null

  return (
    <AdminShell
      title={t.admin.audit.title}
      description={t.admin.audit.description}
      wideDescription
    >
      <PendingForm
        busy={t.common.loading}
        method="get"
        className="mb-6 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <Field>
          <FieldLabel htmlFor="action">{t.admin.audit.filterAction}</FieldLabel>
          <NativeSelect
            id="action"
            name="action"
            defaultValue={query.action ?? ""}
            className="w-full"
          >
            <option value="">{t.admin.users.any}</option>
            {page.actions.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="outcome">
            {t.admin.audit.filterOutcome}
          </FieldLabel>
          <NativeSelect
            id="outcome"
            name="outcome"
            defaultValue={query.outcome ?? ""}
            className="w-full"
          >
            <option value="">{t.admin.users.any}</option>
            {OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcome}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <SubmitButton variant="outline">{t.admin.audit.apply}</SubmitButton>
      </PendingForm>

      {page.events.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>{t.admin.audit.empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.admin.audit.columns.when}</TableHead>
                <TableHead>{t.admin.audit.columns.action}</TableHead>
                <TableHead>{t.admin.audit.columns.outcome}</TableHead>
                <TableHead>{t.admin.audit.columns.actor}</TableHead>
                <TableHead>{t.admin.audit.columns.target}</TableHead>
                <TableHead>{t.admin.audit.columns.details}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="text-xs tabular-nums">
                    <LocalTime iso={event.createdAt} />
                  </TableCell>
                  <TableCell className="text-xs font-medium">
                    {event.action}
                  </TableCell>
                  <TableCell
                    className={
                      event.outcome === "success"
                        ? "text-xs"
                        : "text-xs text-destructive"
                    }
                  >
                    {event.outcome}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Actor event={event} names={page.names} />
                  </TableCell>
                  <TableCell className="text-xs">
                    <Target event={event} names={page.names} t={t} />
                  </TableCell>
                  <TableCell className="max-w-sm truncate text-xs text-muted-foreground">
                    {event.metadata ?? ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {page.nextBefore ? (
        <p className="mt-4">
          <Link
            to="/admin/audit"
            search={{ ...query, before: page.nextBefore }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {t.admin.audit.more}
          </Link>
        </p>
      ) : null}
    </AdminShell>
  )
}

/**
 * Who caused the event.
 *
 * A user id becomes their name and links to them; a deleted account keeps the
 * short id, because the row outlives the account. With no user id at all the
 * actor is a machine — `system` at start-up, `cli` from the operator CLI,
 * `anonymous` for something nobody was signed in for — and the type is the
 * honest answer rather than a dash.
 */
function Actor({
  event,
  names,
}: {
  event: AdminAuditRow
  names: Record<string, string>
}) {
  if (!event.actorUserId) return <>{event.actorType ?? "—"}</>

  return (
    <Link
      to="/admin/users/$userId"
      params={{ userId: event.actorUserId }}
      className="underline underline-offset-4"
      title={event.actorUserId}
    >
      {names[event.actorUserId] ?? event.actorUserId.slice(0, 8)}
    </Link>
  )
}

/**
 * What it happened to — the type, and a label the type decides.
 *
 * A user resolves to a name and links; a client is already readable, since
 * `targetId` *is* the client id; an API key has nothing readable at all, so it
 * gets a short id. Everything else falls back to the same short id rather than
 * pretending to know more.
 */
function Target({
  event,
  names,
  t,
}: {
  event: AdminAuditRow
  names: Record<string, string>
  t: Catalog
}) {
  if (!event.targetId) return <>—</>

  const type = event.targetType ?? ""
  const short = event.targetId.slice(0, 8)

  if (type === "user") {
    return (
      <Link
        to="/admin/users/$userId"
        params={{ userId: event.targetId }}
        className="underline underline-offset-4"
        title={event.targetId}
      >
        {names[event.targetId] ?? short}
      </Link>
    )
  }

  return (
    <span title={event.targetId}>
      <span className="text-muted-foreground">
        {t.admin.audit.targetType(type || "—")}{" "}
      </span>
      {type === "client" ? event.targetId : short}
    </span>
  )
}
