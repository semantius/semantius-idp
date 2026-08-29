import { Link, createFileRoute, notFound } from "@tanstack/react-router"

import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Input } from "@workspace/ui/components/input"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Label } from "@workspace/ui/components/label"
import { NativeSelect } from "@workspace/ui/components/native-select"
import { Separator } from "@workspace/ui/components/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

import {
  AdminCard,
  AdminShell,
  DetailRow,
} from "@/components/admin/admin-shell"
import { ActionDialog } from "@/components/common/dialogs"
import { UserBadges } from "@/components/admin/user-badges"
import { FormRefusal } from "@/components/auth/form-parts"
import { NoticeToast, SUBJECT_PARAM } from "@/components/common/notice-toast"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { adminHead } from "@/lib/page-title"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import { runAdminAction } from "@/server/http/admin-actions"
import { readFormMulti, redirectWithCookies } from "@/server/http/auth-proxy"
import { requireSession } from "@/server/http/require-session"
import { stash } from "@/server/http/one-shot"
import { fetchUserDetail } from "@/server/functions/admin"
import { getRuntime } from "@/server/runtime"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { LocalTime } from "@/components/common/local-time"

/**
 * `/admin/users/:id` — everything about one account, and everything that can
 * be done to it (FR-ADMIN-2..5, FR-KEY-1, FR-2FA-2, FR-ROLE-2).
 *
 * All the buttons post to this one URL with an `action` field, and the
 * dispatcher in `http/admin-actions.ts` is what turns each into a call to
 * Better Auth. Nothing here writes to the database: that is what keeps the
 * invariants (`admin/guard.ts`) and the audit trail in the path, and it is why
 * an administrator cannot ban the last administrator from this page any more
 * than from `curl`.
 *
 * Every write on this page requires a session, read authoritatively so a
 * suspension or a revocation bites on the next write rather than whenever the
 * cookie cache happens to expire. It used to require a *fresh* one as well;
 * **D81** removed that.
 *
 * **The actions are links that open dialogs** (item 11). Eleven inline forms in
 * one column is a wall of controls where the important ones — suspend, delete —
 * sit at the same weight as the rest, and where "delete this account" was a
 * bare button with a sentence above it. Each is now a named control that opens
 * the form it has always had; the POST bodies, the `action` values and the
 * dispatcher underneath them are unchanged.
 *
 * **Two of them became one link** (**D93**). Edit profile and Roles are two
 * halves of one record, not two actions, and they are `/admin/users/$userId/
 * edit` now — one form with one Save. Everything else on this page is a
 * confirmation with at most two inputs and stays exactly where it is: the
 * rule is *every create and every edit is a page, every confirmation is a
 * modal*, and "sign out everywhere" is not an edit.
 *
 * **The nine surviving forms still post to this URL with no `action`
 * attribute** — `/admin/users/<id>`, un-slashed — while this file now
 * generates the route `/admin/users/$userId/`. That works for the same reason
 * `/admin/users`'s own handler always has: an index route answers the
 * un-slashed path. It is worth knowing, because the failure mode would have
 * been a silent 404 on nine admin actions.
 */
export const Route = createFileRoute("/admin/users/$userId/")({
  loader: async ({ context, params, location }) => {
    const user = await fetchUserDetail({ data: params.userId })
    if (!user) throw notFound()
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      gate: context.gate,
      // The trail ends at the account, and its label is the address — which is
      // also this page's `<h1>` (**D93**). The list crumb above it is what a
      // route nested one level deeper cannot supply for itself.
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.users, to: "/admin/users" },
        { label: user.email },
      ]),
      user,
      // The role catalog went with the form (**D93**): the checkboxes are on
      // `$userId/edit` now, and this page shows the roles it holds as badges.
      notice: searchString(search.notice),
      error: searchString(search.error),
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, () => loaderData?.user.email ?? ""),
  component: UserDetailPage,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const userId = params.userId
        const here = `${base}/admin/users/${encodeURIComponent(userId)}`

        const signedIn = await requireSession(runtime, request, here)
        if (!signedIn.ok) return signedIn.response

        // `readFormMulti`, because a checkbox group repeats its field and the
        // plain reader keeps only the last ticked box. The **join moved into
        // the dispatcher** (**D93**): it used to be three lines here, and a
        // second route dispatching `set-roles` without them would have stored
        // one role of several under a success toast.
        const { fields: form, list: valuesOf } = await readFormMulti(request)
        const outcome = await runAdminAction(form.action ?? "", {
          runtime,
          request,
          form,
          list: valuesOf,
          userId,
          actorId: signedIn.session.user.id,
        })

        const query = new URLSearchParams()
        if (outcome.notice) query.set("notice", outcome.notice)
        if (outcome.error) query.set("error", outcome.error)
        // **D78**: a handle, never the address. `safeUrlForLog` keeps the query
        // string of everything outside `/oauth2/*` and `/api/auth/*`, so
        // `?subject=jane@example.com` would put a deleted account's address in
        // the request log — in a codebase that anonymizes IP addresses for
        // exactly that reason (SEC-5). Two minutes is a redirect's worth of
        // life; the claim consumes it either way.
        if (outcome.subject) {
          query.set(
            SUBJECT_PARAM,
            await stash(runtime, outcome.subject, { ttlSeconds: 120 })
          )
        }
        const suffix = query.toString() ? `?${query.toString()}` : ""

        // The suffix goes on whichever destination was chosen. It used to be
        // dropped for a redirecting action, which is why `delete` had to spell
        // `?notice=deleted` into its own redirect — and why nothing else could
        // travel with it.
        return redirectWithCookies(
          `${outcome.redirect ? `${base}${outcome.redirect}` : here}${suffix}`,
          outcome.cookies
        )
      },
    },
  },
})

/** Ban durations offered, in seconds. Empty means "until lifted". */
const BAN_DURATIONS = [
  { value: "", labelKey: "banForever" as const },
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
]

function UserDetailPage() {
  const { ui, gate, user, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const self = gate.admin && gate.email === user.email

  return (
    /*
     * No "Users" button beside the heading (**D95**). It was the way back to
     * the list before there was a breadcrumb; since **D93** the trail above
     * this page ends `User Manager › Users › <address>` and its middle crumb
     * is that link — in a row that is always on screen, because the header
     * sits outside the scroll container. The `actions` slot is for what a
     * page *does*, which is how every other page uses it.
     */
    <AdminShell
      title={user.email}
      description={<UserBadges user={user} t={t} />}
    >
      <FormRefusal>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormRefusal>
      {/* **D78**: which account, taken straight from the loader — every
          action on this page comes back to this page, so there is nothing to
          carry across a redirect. `delete` is the exception and lands on the
          list, which is why the dispatcher hands *that* one its subject. */}
      <NoticeToast
        message={messageForNoticeCode(notice, t)}
        subject={user.email}
      />

      {user.unknownRoles.length > 0 ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            {t.admin.detail.unknownRoles(user.unknownRoles.join(", "))}
          </AlertDescription>
        </Alert>
      ) : null}
      {user.profileConflict ? (
        <Alert className="mb-4">
          <AlertDescription>{t.admin.detail.profileConflict}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="grid gap-8">
          <AdminCard>
            <dl className="divide-y">
              <DetailRow label={t.admin.users.columns.user}>
                {user.name || "—"}
              </DetailRow>
              <DetailRow label={t.admin.users.columns.roles}>
                {user.roles.length === 0
                  ? "—"
                  : user.roles.map((role) => (
                      <Badge key={role} variant="outline" className="mr-1">
                        {role}
                      </Badge>
                    ))}
              </DetailRow>
              <DetailRow label={t.admin.users.columns.created}>
                <LocalTime iso={user.createdAt} />
              </DetailRow>
              {user.banned && user.banReason ? (
                <DetailRow label={t.admin.actions.banReason}>
                  {user.banReason}
                </DetailRow>
              ) : null}
            </dl>
          </AdminCard>

          <AdminCard title={t.admin.detail.identities}>
            {user.identities.length === 0 ? (
              <Empty>{t.admin.detail.noIdentities}</Empty>
            ) : (
              <ul className="grid gap-1 text-sm">
                {user.identities.map((identity) => (
                  <li key={`${identity.providerId}:${identity.accountId}`}>
                    <span className="font-medium">{identity.providerId}</span>{" "}
                    <span className="text-muted-foreground">
                      <LocalTime iso={identity.createdAt} variant="date" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>

          <AdminCard title={t.admin.detail.sessions}>
            {user.sessions.length === 0 ? (
              <Empty>{t.admin.detail.noSessions}</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.admin.detail.started}</TableHead>
                    <TableHead>{t.admin.detail.ip}</TableHead>
                    <TableHead>{t.admin.detail.device}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {user.sessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell className="text-xs">
                        <LocalTime iso={session.createdAt} />
                        {session.impersonated ? (
                          <Badge variant="destructive" className="ml-2">
                            {t.admin.detail.impersonatedSession}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        {session.ipAddress ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs">
                        {session.userAgent ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </AdminCard>

          {ui.apiKeysEnabled ? (
            <AdminCard title={t.admin.detail.apiKeys}>
              {user.apiKeys.length === 0 ? (
                <Empty>{t.admin.detail.noApiKeys}</Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.admin.actions.keyName}</TableHead>
                      <TableHead>{t.admin.detail.keyCreated}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {user.apiKeys.map((key) => (
                      <TableRow key={key.id}>
                        <TableCell className="text-xs">
                          {key.name || key.start || key.id.slice(0, 8)}
                        </TableCell>
                        <TableCell className="text-xs">
                          <LocalTime iso={key.createdAt} variant="date" />
                        </TableCell>
                        <TableCell className="text-right">
                          <PendingForm busy={t.common.loading} method="post">
                            <input
                              type="hidden"
                              name="action"
                              value="revoke-key"
                            />
                            <input type="hidden" name="keyId" value={key.id} />
                            <SubmitButton variant="outline" size="sm">
                              {t.admin.actions.revokeKey}
                            </SubmitButton>
                          </PendingForm>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </AdminCard>
          ) : null}

          <AdminCard title={t.admin.detail.events}>
            {user.events.length === 0 ? (
              <Empty>{t.admin.detail.noEvents}</Empty>
            ) : (
              <ul className="grid gap-1 text-xs">
                {user.events.map((event) => (
                  <li key={event.id} className="flex flex-wrap gap-2">
                    <span className="text-muted-foreground tabular-nums">
                      <LocalTime iso={event.createdAt} />
                    </span>
                    <span className="font-medium">{event.action}</span>
                    <span
                      className={
                        event.outcome === "success"
                          ? "text-muted-foreground"
                          : "text-destructive"
                      }
                    >
                      {event.outcome}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>
        </div>

        {/* `self-start`, not the default `stretch`. As a grid item this
            aside was as tall as the main column, and the grid then distributed
            the surplus height *between* the buttons — which is the "odd
            spacing" in the review (finding 7). It is a menu, so it is grouped
            by what the entries do to the account rather than by the order they
            were added in: the pending queue, then profile and access, then
            credentials and sessions, then the two that need thinking about. */}
        <aside className="self-start">
          <Card size="sm">
            <CardHeader>
              <CardTitle>
                <h3>{t.admin.actions.title}</h3>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {user.status === "pending" ? (
                <>
                  <ConfirmAction
                    busy={t.common.loading}
                    action="approve"
                    label={t.admin.actions.approve}
                    submit={t.admin.actions.approve}
                  />
                  <ActionDialog
                    label={t.admin.actions.reject}
                    className="w-full justify-start"
                  >
                    <PendingForm
                      busy={t.common.loading}
                      method="post"
                      className="grid gap-4"
                    >
                      <input type="hidden" name="action" value="reject" />
                      <Label className="group/field-label flex items-center gap-2 text-sm font-normal">
                        {/* See `role-checkboxes.tsx`: Base UI's control is a span,
                          so the wrapping label does not name it. */}
                        <Checkbox
                          name="notify"
                          aria-label={t.admin.detail.notifyRejection}
                        />
                        {t.admin.detail.notifyRejection}
                      </Label>
                      <SubmitButton variant="outline">
                        {t.admin.actions.reject}
                      </SubmitButton>
                    </PendingForm>
                  </ActionDialog>
                  {/* Inside the conditional: a separator with nothing above
                      it is a rule across the top of the menu. */}
                  <Separator className="my-1" />
                </>
              ) : null}
              {/* **D93**: Edit profile and Roles were two dialogs with two
                  Saves over two halves of one record. An administrator who
                  corrected an address *and* granted a role, then pressed the
                  Profile save, got "Profile updated." in a toast and lost the
                  role grant with no signal at all — silently, on the
                  authorization surface, confirmed by a success message. One
                  link, one form, one Save. */}
              <Link
                to="/admin/users/$userId/edit"
                params={{ userId: user.id }}
                className={buttonVariants({
                  variant: "outline",
                  size: "sm",
                  className: "w-full justify-start",
                })}
              >
                {t.admin.actions.editProfile}
              </Link>
              <Separator className="my-1" />
              {ui.emailEnabled ? (
                <ActionDialog
                  label={t.admin.actions.sendReset}
                  className="w-full justify-start"
                >
                  <PendingForm
                    busy={t.common.loading}
                    method="post"
                    className="grid gap-4"
                  >
                    <input type="hidden" name="action" value="send-reset" />
                    <input type="hidden" name="email" value={user.email} />
                    <SubmitButton variant="outline">
                      {t.admin.actions.sendReset}
                    </SubmitButton>
                  </PendingForm>
                </ActionDialog>
              ) : null}
              <ActionDialog
                label={t.admin.actions.temporaryPassword}
                description={t.admin.actions.temporaryPasswordHelp}
                className="w-full justify-start"
              >
                <PendingForm
                  busy={t.common.loading}
                  method="post"
                  className="grid gap-4"
                >
                  <input
                    type="hidden"
                    name="action"
                    value="temporary-password"
                  />
                  <Field>
                    <FieldLabel htmlFor="newPassword">
                      {t.admin.actions.temporaryPassword}
                    </FieldLabel>
                    <Input
                      id="newPassword"
                      name="newPassword"
                      type="text"
                      autoComplete="off"
                      required
                      minLength={ui.passwordMinLength}
                    />
                  </Field>
                  <SubmitButton variant="outline">
                    {t.admin.actions.save}
                  </SubmitButton>
                </PendingForm>
              </ActionDialog>
              <ConfirmAction
                busy={t.common.loading}
                action="revoke-sessions"
                label={t.admin.actions.revokeSessions}
                submit={t.admin.actions.revokeSessions}
              />
              {user.twoFactorEnabled ? (
                <ConfirmAction
                  busy={t.common.loading}
                  action="reset-two-factor"
                  label={t.admin.actions.resetTwoFactor}
                  submit={t.admin.actions.resetTwoFactor}
                />
              ) : null}
              {ui.allowImpersonation ? (
                <ActionDialog
                  label={t.admin.actions.impersonate}
                  description={t.admin.actions.impersonateHelp}
                  className="w-full justify-start"
                >
                  <PendingForm
                    busy={t.common.loading}
                    method="post"
                    className="grid gap-4"
                  >
                    <input type="hidden" name="action" value="impersonate" />
                    <SubmitButton variant="outline" disabled={self}>
                      {t.admin.actions.impersonate}
                    </SubmitButton>
                  </PendingForm>
                </ActionDialog>
              ) : null}
              <Separator className="my-1" />
              {user.banned ? (
                <ConfirmAction
                  busy={t.common.loading}
                  action="unban"
                  label={t.admin.actions.unban}
                  submit={t.admin.actions.unban}
                />
              ) : (
                <ActionDialog
                  label={t.admin.actions.ban}
                  className="w-full justify-start"
                >
                  <PendingForm
                    busy={t.common.loading}
                    method="post"
                    className="grid gap-4"
                  >
                    <input type="hidden" name="action" value="ban" />
                    <Field>
                      <FieldLabel htmlFor="banReason">
                        {t.admin.actions.banReason}
                      </FieldLabel>
                      <Input id="banReason" name="banReason" />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="banExpiresIn">
                        {t.admin.actions.banDuration}
                      </FieldLabel>
                      <NativeSelect
                        id="banExpiresIn"
                        name="banExpiresIn"
                        className="w-full"
                      >
                        {BAN_DURATIONS.map((duration) => (
                          <option key={duration.value} value={duration.value}>
                            {duration.labelKey
                              ? t.admin.actions.banForever
                              : duration.label}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <SubmitButton variant="destructive" disabled={self}>
                      {t.admin.actions.ban}
                    </SubmitButton>
                  </PendingForm>
                </ActionDialog>
              )}
              {/* The one action nothing undoes, so it is the one that asks. */}
              <ActionDialog
                label={t.admin.actions.delete}
                description={t.admin.actions.deleteConfirm}
                variant="destructive"
                className="w-full justify-start"
              >
                <PendingForm
                  busy={t.common.loading}
                  method="post"
                  className="grid gap-4"
                >
                  <input type="hidden" name="action" value="delete" />
                  <SubmitButton variant="destructive" disabled={self}>
                    {t.admin.actions.delete}
                  </SubmitButton>
                </PendingForm>
              </ActionDialog>
            </CardContent>
          </Card>
        </aside>
      </div>
    </AdminShell>
  )
}

/**
 * An action with nothing to fill in — a dialog whose whole body is the
 * confirmation and the button.
 *
 * These could have stayed inline buttons, and deliberately did not: a column
 * where some controls open a dialog and others fire on the first click is a
 * column where the difference has to be learnt by pressing one.
 */
function ConfirmAction({
  action,
  label,
  submit,
  busy,
}: {
  action: string
  label: string
  submit: string
  busy: string
}) {
  return (
    <ActionDialog label={label} className="w-full justify-start">
      <PendingForm busy={busy} method="post" className="grid gap-4">
        <input type="hidden" name="action" value={action} />
        <SubmitButton variant="outline">{submit}</SubmitButton>
      </PendingForm>
    </ActionDialog>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}
