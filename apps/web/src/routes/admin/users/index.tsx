import { Link, createFileRoute } from "@tanstack/react-router"

import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
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
import { SecretDialog } from "@/components/common/dialogs"
import { UserBadges } from "@/components/admin/user-badges"
import { FormAlert } from "@/components/auth/form-parts"
import { messageForNoticeCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  claimAdminSecret,
  fetchRoles,
  fetchUsers,
} from "@/server/functions/admin"

/**
 * `/admin/users` — the list (FR-ADMIN-2).
 *
 * Every control is a `GET` form, so the state of the screen *is* the URL: a
 * filtered list can be linked to, bookmarked, and reloaded, and the back button
 * does what it looks like it does. That is worth more here than anywhere else
 * in the app — "the pending accounts" is a link an administrator sends to a
 * colleague.
 *
 * It is also where a creation lands (item 10). With e-mail on that is a
 * notice; with e-mail off the one-time set-password link opens in a dialog,
 * claimed from a server-side stash rather than read out of the query string —
 * a link that grants a password reset does not belong in browser history.
 */
export const Route = createFileRoute("/admin/users/")({
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
      q: searchString(search.q),
      status: searchString(search.status),
      role: searchString(search.role),
      sort: (searchString(search.sort) ?? "createdAt") as "createdAt",
      direction: (searchString(search.direction) ?? "desc") as "desc",
      page: Number(searchString(search.page) ?? "1") || 1,
      pageSize: Number(searchString(search.pageSize) ?? "25") || 25,
    }
    return {
      ui: context.ui,
      gate: context.gate,
      query,
      page: await fetchUsers({ data: query }),
      roles: (await fetchRoles()) ?? [],
      notice: searchString(search.notice),
      // Claimed, and therefore consumed: this render is the only one that can
      // show it, which is what "it works once" has to mean on this side too.
      inviteLink: await claimAdminSecret({
        data: searchString(search.created) ?? "",
      }),
    }
  },
  component: UsersPage,
})

const STATUSES = ["pending", "active", "rejected"] as const

function UsersPage() {
  const { ui, gate, query, page, roles, notice, inviteLink } =
    Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const impersonated = gate.admin ? gate.impersonated : false

  if (!page) return null

  const from = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1
  const to = Math.min(page.total, page.page * page.pageSize)

  return (
    <AdminShell
      ui={ui}
      t={t}
      title={t.admin.users.title}
      impersonated={impersonated}
      actions={
        <Link to="/admin/users/new" className={`${buttonVariants()} h-9 px-4`}>
          {t.admin.users.create}
        </Link>
      }
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>

      {inviteLink ? (
        <SecretDialog
          t={t}
          title={t.admin.create.linkTitle}
          description={t.admin.create.linkHelp}
          value={inviteLink}
          wrap
        />
      ) : null}

      {/* GET, so the filters land in the URL rather than in component state. */}
      <form
        method="get"
        className="mb-6 grid gap-3 sm:grid-cols-[1fr_10rem_10rem_auto] sm:items-end"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="q">{t.admin.users.search}</Label>
          <Input id="q" name="q" defaultValue={query.q ?? ""} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="status">{t.admin.users.filterStatus}</Label>
          <select
            id="status"
            name="status"
            defaultValue={query.status ?? ""}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="">{t.admin.users.any}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {t.admin.status[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="role">{t.admin.users.filterRole}</Label>
          <select
            id="role"
            name="role"
            defaultValue={query.role ?? ""}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="">{t.admin.users.any}</option>
            {roles.map((role) => (
              <option key={role.name} value={role.name}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {t.admin.users.searchAction}
        </Button>
      </form>

      {page.users.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.admin.users.empty}</p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.admin.users.columns.user}</TableHead>
                <TableHead>{t.admin.users.columns.status}</TableHead>
                <TableHead>{t.admin.users.columns.roles}</TableHead>
                <TableHead>{t.admin.users.columns.created}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <Link
                      to="/admin/users/$userId"
                      params={{ userId: user.id }}
                      className="font-medium underline underline-offset-4"
                    >
                      {user.email}
                    </Link>
                    {user.name ? (
                      <span className="block text-xs text-muted-foreground">
                        {user.name}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <UserBadges user={user} t={t} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {user.roles.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      user.roles.map((role) => (
                        <Badge key={role} variant="outline" className="mr-1">
                          {role}
                        </Badge>
                      ))
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {user.createdAt.slice(0, 10)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <nav
        className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"
        aria-label={t.admin.users.title}
      >
        <p className="text-muted-foreground">
          {t.admin.users.showing(from, to, page.total)}
        </p>
        <div className="flex gap-2">
          {page.page > 1 ? (
            <Link
              to="/admin/users"
              search={{ ...query, page: page.page - 1 }}
              className={`${buttonVariants({ variant: "outline", size: "sm" })}`}
            >
              {t.admin.users.previous}
            </Link>
          ) : null}
          {to < page.total ? (
            <Link
              to="/admin/users"
              search={{ ...query, page: page.page + 1 }}
              className={`${buttonVariants({ variant: "outline", size: "sm" })}`}
            >
              {t.admin.users.next}
            </Link>
          ) : null}
        </div>
      </nav>
    </AdminShell>
  )
}
