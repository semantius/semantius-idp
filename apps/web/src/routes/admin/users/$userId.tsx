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
import { RoleCheckboxes } from "@/components/admin/role-checkboxes"
import { ActionDialog } from "@/components/common/dialogs"
import { UserBadges } from "@/components/admin/user-badges"
import { FormAlert } from "@/components/auth/form-parts"
import { NoticeToast, SUBJECT_PARAM } from "@/components/common/notice-toast"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import { runAdminAction } from "@/server/http/admin-actions"
import { readFormMulti, redirectWithCookies } from "@/server/http/auth-proxy"
import { requireFreshSession } from "@/server/http/fresh-session"
import { stash } from "@/server/http/one-shot"
import { fetchRoles, fetchUserDetail } from "@/server/functions/admin"
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
 * The whole page is behind the freshness gate. Administrative actions are the
 * definition of a "sensitive operation" in FR-AUTH-5, and an admin session
 * left open on a shared machine is exactly the case it exists for.
 *
 * **The actions are links that open dialogs** (item 11). Eleven inline forms in
 * one column is a wall of controls where the important ones — suspend, delete —
 * sit at the same weight as the rest, and where "delete this account" was a
 * bare button with a sentence above it. Each is now a named control that opens
 * the form it has always had; the POST bodies, the `action` values and the
 * dispatcher underneath them are unchanged.
 */
export const Route = createFileRoute("/admin/users/$userId")({
  loader: async ({ context, params, location }) => {
    const user = await fetchUserDetail({ data: params.userId })
    if (!user) throw notFound()
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      gate: context.gate,
      user,
      // The catalog, so roles are checkboxes rather than a comma-separated
      // field an administrator has to spell from memory (item 11b).
      roles: (await fetchRoles()) ?? [],
      notice: searchString(search.notice),
      error: searchString(search.error),
    }
  },
  component: UserDetailPage,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const userId = params.userId
        const here = `${base}/admin/users/${encodeURIComponent(userId)}`

        const fresh = await requireFreshSession(runtime, request, here)
        if (!fresh.ok) return fresh.response

        // `readFormMulti`, because the roles control repeats its field and
        // the plain reader keeps only the last ticked box.
        const { fields: form, list: valuesOf } = await readFormMulti(request)
        if (form.action === "set-roles") {
          // `set-roles` has always split a comma string; joining here keeps
          // the dispatcher and its tests untouched by the UI change.
          form.roles = valuesOf("roles").join(",")
        }
        const outcome = await runAdminAction(form.action ?? "", {
          runtime,
          request,
          form,
          userId,
          actorId: fresh.session.user.id,
        })

        const query = new URLSearchParams()
        if (outcome.notice) query.set("notice", outcome.notice)
        if (outcome.error) query.set("error", outcome.error)
        // **D78**: a handle, never the address. `safeUrlForLog` keeps the query
        // string of everything outside `/oauth2/*` and `/api/auth/*`, so
        // `?subject=jane@example.com` would put a deleted account's address in
        // the request log — in a codebase that anonymises IP addresses for
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
  const { ui, gate, user, roles, notice, error } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const impersonated = gate.admin ? gate.impersonated : false
  const self = gate.admin && gate.email === user.email

  return (
    <AdminShell
      ui={ui}
      t={t}
      title={user.email}
      description={<UserBadges user={user} t={t} />}
      impersonated={impersonated}
      actions={
        <Link
          to="/admin/users"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {t.admin.users.title}
        </Link>
      }
    >
      <FormAlert>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormAlert>
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
              <ActionDialog
                label={t.admin.actions.editProfile}
                description={t.admin.actions.editProfileHelp}
                className="w-full justify-start"
              >
                <PendingForm
                  busy={t.common.loading}
                  method="post"
                  className="grid gap-4"
                >
                  <input type="hidden" name="action" value="edit-profile" />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="firstName">
                        {t.common.firstName}
                      </FieldLabel>
                      <Input
                        id="firstName"
                        name="firstName"
                        defaultValue={user.firstName}
                        autoComplete="off"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="lastName">
                        {t.common.lastName}
                      </FieldLabel>
                      <Input
                        id="lastName"
                        name="lastName"
                        defaultValue={user.lastName}
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel htmlFor="email">{t.common.email}</FieldLabel>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      defaultValue={user.email}
                      autoComplete="off"
                    />
                  </Field>
                  <Label className="group/field-label flex items-center gap-2 text-sm font-normal">
                    <Checkbox
                      name="emailVerified"
                      aria-label={t.admin.actions.emailVerifiedLabel}
                      defaultChecked={user.emailVerified}
                    />
                    {t.admin.actions.emailVerifiedLabel}
                  </Label>
                  <SubmitButton>{t.admin.actions.save}</SubmitButton>
                </PendingForm>
              </ActionDialog>
              <ActionDialog
                label={t.admin.actions.setRoles}
                description={t.admin.actions.setRolesHelp}
                className="w-full justify-start"
              >
                <PendingForm
                  busy={t.common.loading}
                  method="post"
                  className="grid gap-4"
                >
                  <input type="hidden" name="action" value="set-roles" />
                  <RoleCheckboxes
                    roles={roles}
                    legend={t.admin.actions.setRoles}
                    checked={user.roles}
                  />
                  <SubmitButton variant="outline" disabled={self}>
                    {t.admin.actions.save}
                  </SubmitButton>
                </PendingForm>
              </ActionDialog>
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
