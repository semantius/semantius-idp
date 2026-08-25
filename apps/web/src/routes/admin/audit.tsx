import { Link, createFileRoute } from "@tanstack/react-router"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Label } from "@workspace/ui/components/label"
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
import { getCatalog } from "@/server/i18n"
import { fetchAuditPage } from "@/server/functions/admin"

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
      gate: context.gate,
      query,
      page: await fetchAuditPage({ data: query }),
    }
  },
  component: AuditPage,
})

const OUTCOMES = ["success", "failure", "denied"] as const

function AuditPage() {
  const { ui, gate, query, page } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  if (!page) return null

  return (
    <AdminShell
      ui={ui}
      t={t}
      title={t.admin.audit.title}
      description={t.admin.audit.description}
      impersonated={gate.admin ? gate.impersonated : false}
    >
      <form
        method="get"
        className="mb-6 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="action">{t.admin.audit.filterAction}</Label>
          <select
            id="action"
            name="action"
            defaultValue={query.action ?? ""}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="">{t.admin.users.any}</option>
            {page.actions.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="outcome">{t.admin.audit.filterOutcome}</Label>
          <select
            id="outcome"
            name="outcome"
            defaultValue={query.outcome ?? ""}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="">{t.admin.users.any}</option>
            {OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcome}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {t.admin.audit.apply}
        </Button>
      </form>

      {page.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.admin.audit.empty}</p>
      ) : (
        <div className="rounded-lg border bg-card">
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
                    {event.createdAt.slice(0, 19).replace("T", " ")}
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
                    {event.actorUserId ? (
                      <Link
                        to="/admin/users/$userId"
                        params={{ userId: event.actorUserId }}
                        className="underline underline-offset-4"
                      >
                        {event.actorUserId.slice(0, 8)}
                      </Link>
                    ) : (
                      (event.actorType ?? "—")
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {event.targetId ? event.targetId.slice(0, 8) : "—"}
                  </TableCell>
                  <TableCell className="max-w-sm truncate text-xs text-muted-foreground">
                    {event.metadata ?? ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
