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
import { UserCreateDialog } from "@/components/admin/user-create-dialog"
import { FormAlert } from "@/components/auth/form-parts"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { parseInviteLink } from "@/lib/invite-link"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  claimAdminDraft,
  claimAdminSecret,
  fetchRoles,
  fetchUsers,
} from "@/server/functions/admin"
import {
  callAuth,
  errorCodeFor,
  readFormMulti,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { stashDraft, withDraft } from "@/server/http/draft"
import { requireFreshSession } from "@/server/http/fresh-session"
import { stash } from "@/server/http/one-shot"
import { createResetLink } from "@/server/auth/reset-link"
import { displayName } from "@/server/display-name"
import { getRuntime } from "@/server/runtime"
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
 * It is also where a creation happens and where it lands (**D64**, item 10).
 * The form was `/admin/users/new`, a page whose only outcome was to come back
 * here — while the *other* outcome of the same action, the one-time
 * set-password link when e-mail is off, already opened as a dialog on this
 * page. One action, two outcomes, two surfaces. Both are here now, and the
 * POST handler came with the form.
 *
 * With e-mail on a creation is a notice; with e-mail off the one-time
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
      gate: context.gate,
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
      // A refused creation, so the dialog reopens with what was typed (D62).
      draft:
        (await claimAdminDraft({ data: searchString(search.draft) ?? "" })) ??
        undefined,
    }
  },
  component: UsersPage,
  server: {
    handlers: {
      /**
       * Create an account on someone's behalf (FR-ADMIN-2, **D64**).
       *
       * Created **approved and confirmed**: an administrator typing the
       * address is the vouching that the approval queue and the verification
       * e-mail exist to obtain, and making them then approve their own
       * creation would be a step that teaches people to click through steps.
       *
       * The password is never chosen here. With e-mail on they get a
       * `setPassword` link; with e-mail off (FR-MAIL-2) the same one-time link
       * is handed over on screen *once*, because a server that cannot send
       * mail still has to be able to onboard somebody — and an administrator
       * typing a password into a form is a password that exists in two heads
       * and a browser history. The link is stashed server-side and the
       * redirect carries a handle: a one-time password-setting URL in a query
       * string is one in browser history and in every proxy log on the way.
       */
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const list = `${runtime.config.base.basePath}${HERE}`

        // Roles are checkboxes, so the field repeats; `readForm` keeps only
        // the last value of a repeated key, which would silently drop every
        // role but one. Read before the gate (D63), so a session that went
        // stale while the dialog was open does not cost the form.
        const { fields: form, list: valuesOf } = await readFormMulti(request)
        const email = (form.email ?? "").trim()
        const firstName = form.firstName ?? ""
        const lastName = form.lastName ?? ""
        const roles = valuesOf("roles")
        const submitted = {
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          roles,
        }

        const fresh = await requireFreshSession(runtime, request, HERE, {
          draft: submitted,
        })
        if (!fresh.ok) return fresh.response

        const created = await callAuth(
          runtime,
          "/admin/create-user",
          {
            email,
            // D49: derived from the parts, never typed. FR-SIGNUP-5 asks for
            // first and last name everywhere an account is made, and this was
            // the one place still asking for a single free-text `name`.
            name:
              displayName(
                firstName,
                lastName,
                runtime.config.file.site.nameFormat
              ) || email,
            // A random password nobody will ever use: the account is reached
            // through the set-password link, and a null password would make it
            // a social-only account, which is not what was asked for.
            password: crypto.randomUUID() + crypto.randomUUID(),
            ...(roles.length ? { role: roles } : {}),
            data: {
              status: "active",
              emailVerified: true,
              ...(firstName ? { firstName } : {}),
              ...(lastName ? { lastName } : {}),
            },
          },
          request
        )
        if (!created.ok) {
          const draft = await stashDraft(runtime, submitted)
          return redirectWithCookies(
            withError(withDraft(list, draft), errorCodeFor(created))
          )
        }

        const user = created.body.user as { id?: string } | undefined
        // The `user.created` row is the guard's, written from its hook on
        // `/admin/create-user` so that a direct API call leaves the same trail
        // (**D66**). It used to be written here, as `signup.created` with
        // `by: "admin"` — three different events under one action name, on a
        // page whose filter lists action names.

        // `welcome=1`: the same page, told to say "an administrator created an
        // account for you" rather than "choose a new password", and to leave
        // out the promise about other devices (D65).
        const reset = await createResetLink(runtime, user?.id ?? "", {
          welcome: true,
        })

        if (runtime.mailer.enabled) {
          await runtime.mailer.send("setPassword", email, { url: reset.url })
          return redirectWithCookies(`${list}?notice=created`)
        }

        // FR-MAIL-2: nothing can be sent, so the link is handed over on screen
        // — once, in a dialog on this page, and never in the address bar.
        const handle = await stash(
          runtime,
          JSON.stringify({ url: reset.url, email }),
          { ttlSeconds: 600 }
        )
        return redirectWithCookies(`${list}?created=${handle}`)
      },
    },
  },
})


const STATUSES = ["pending", "active", "rejected"] as const

function UsersPage() {
  const { ui, gate, query, page, roles, notice, error, inviteLink, draft } =
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
        <UserCreateDialog
          t={t}
          roles={roles}
          draft={draft}
          reopen={draft !== undefined}
          error={
            draft !== undefined
              ? messageForErrorCode(error, t, ui.passwordMinLength)
              : undefined
          }
        />
      }
    >
      <FormAlert variant="default">{messageForNoticeCode(notice, t)}</FormAlert>
      {/* Not when the dialog is reopening with it — the modal would cover it. */}
      <FormAlert>
        {draft === undefined
          ? messageForErrorCode(error, t, ui.passwordMinLength)
          : undefined}
      </FormAlert>

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
