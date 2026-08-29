import { Link, createFileRoute } from "@tanstack/react-router"

import { Badge } from "@workspace/ui/components/badge"
import { Card } from "@workspace/ui/components/card"
import { buttonVariants } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
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
import { SecretDialog } from "@/components/common/dialogs"
import { UserBadges } from "@/components/admin/user-badges"
import { FormRefusal } from "@/components/auth/form-parts"
import { NoticeToast, SUBJECT_PARAM } from "@/components/common/notice-toast"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { adminHead } from "@/lib/page-title"
import { parseInviteLink } from "@/lib/invite-link"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  claimAdminSecret,
  fetchRoles,
  fetchUsers,
} from "@/server/functions/admin"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { LocalTime } from "@/components/common/local-time"

const HERE = "/admin/users"

/**
 * `/admin/users` — the list (FR-ADMIN-2).
 *
 * Every control is a `GET` form, so the state of the screen *is* the URL: a
 * filtered list can be linked to, bookmarked, and reloaded, and the back button
 * does what it looks like it does. That is worth more here than anywhere else
 * in the app — "the pending accounts" is a link an administrator sends to a
 * colleague.
 *
 * It is where a creation **lands**, which is D64's actual finding and is not
 * reversed: one action must not have two outcomes on two surfaces. The form
 * itself is `/admin/users/new` again since **D93**, because the test is
 * addressability rather than size — but both of its outcomes still arrive
 * here. With e-mail on a creation is a notice; with e-mail off the one-time
 * set-password link opens in a dialog, claimed from a server-side stash rather
 * than read out of the query string — a link that grants a password reset does
 * not belong in browser history.
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
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.users, to: HERE },
      ]),
      query,
      page: await fetchUsers({ data: query }),
      roles: (await fetchRoles()) ?? [],
      notice: searchString(search.notice),
      error: searchString(search.error),
      // Claimed, and therefore consumed: this render is the only one that can
      // show it, which is what "it works once" has to mean on this side too.
      // `{url, email}` since D65 — an administrator who has just created two
      // accounts otherwise has two identical-looking links.
      inviteLink: parseInviteLink(
        await claimAdminSecret({ data: searchString(search.created) ?? "" })
      ),
      // Who the notice is about (**D78**). The same one-shot store, because
      // the alternative is an e-mail address in the query string and therefore
      // in the request log. Absent for every notice that is not about one
      // account, and for the invite-link path, which carries the address in
      // its own stash already.
      subject:
        (await claimAdminSecret({
          data: searchString(search[SUBJECT_PARAM]) ?? "",
        })) ?? undefined,
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.users.title),
  component: UsersPage,
})

const STATUSES = ["pending", "active", "rejected"] as const

function UsersPage() {
  const { ui, query, page, roles, notice, error, inviteLink, subject } =
    Route.useLoaderData()
  const t = getCatalog(ui.locale)

  if (!page) return null

  const from = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1
  const to = Math.min(page.total, page.page * page.pageSize)

  return (
    <AdminShell
      title={t.admin.users.title}
      actions={
        // A link, not a dialog trigger (**D93**).
        <Link to="/admin/users/new" className={buttonVariants({ size: "sm" })}>
          {t.admin.users.create}
        </Link>
      }
    >
      <NoticeToast message={messageForNoticeCode(notice, t)} subject={subject} />
      <FormRefusal>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormRefusal>

      {inviteLink ? (
        <SecretDialog
          t={t}
          title={t.admin.create.linkTitle}
          description={
            inviteLink.email
              ? t.admin.create.linkFor(inviteLink.email)
              : t.admin.create.linkHelp
          }
          value={inviteLink.url}
        />
      ) : null}

      {/* GET, so the filters land in the URL rather than in component state. */}
      <PendingForm
        busy={t.common.loading}
        method="get"
        className="mb-6 grid gap-3 sm:grid-cols-[1fr_10rem_10rem_auto] sm:items-end"
      >
        <Field>
          <FieldLabel htmlFor="q">{t.admin.users.search}</FieldLabel>
          <Input id="q" name="q" defaultValue={query.q ?? ""} />
        </Field>
        <Field>
          <FieldLabel htmlFor="status">{t.admin.users.filterStatus}</FieldLabel>
          <NativeSelect
            id="status"
            name="status"
            defaultValue={query.status ?? ""}
            className="w-full"
          >
            <option value="">{t.admin.users.any}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {t.admin.status[status]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="role">{t.admin.users.filterRole}</FieldLabel>
          <NativeSelect
            id="role"
            name="role"
            defaultValue={query.role ?? ""}
            className="w-full"
          >
            <option value="">{t.admin.users.any}</option>
            {roles.map((role) => (
              <option key={role.name} value={role.name}>
                {role.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <SubmitButton variant="outline">
          {t.admin.users.searchAction}
        </SubmitButton>
      </PendingForm>

      {page.users.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>{t.admin.users.empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="overflow-x-auto py-0">
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
                    <LocalTime iso={user.createdAt} variant="date" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
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
