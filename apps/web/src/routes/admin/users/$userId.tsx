import { Link, createFileRoute, notFound } from "@tanstack/react-router"

import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Separator } from "@workspace/ui/components/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

import { AdminShell, Field } from "@/components/admin/admin-shell"
import { UserBadges } from "@/components/admin/user-badges"
import { FormAlert } from "@/components/auth/form-parts"
import { messageForErrorCode, messageForNoticeCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import { runAdminAction } from "@/server/http/admin-actions"
import { readForm, redirectWithCookies } from "@/server/http/auth-proxy"
import { requireFreshSession } from "@/server/http/fresh-session"
import { fetchUserDetail } from "@/server/functions/admin"
import { getRuntime } from "@/server/runtime"

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

        const form = await readForm(request)
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
        const suffix = query.toString() ? `?${query.toString()}` : ""

        return redirectWithCookies(
          outcome.redirect ? `${base}${outcome.redirect}` : `${here}${suffix}`,
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
      <FormAlert>{messageForErrorCode(error, t)}</FormAlert>
      {notice ? (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {messageForNoticeCode(notice, t)}
        </p>
      ) : null}

      {user.unknownRoles.length > 0 ? (
        <p className="mb-4 rounded-md border border-destructive/40 p-3 text-sm">
          {t.admin.detail.unknownRoles(user.unknownRoles.join(", "))}
        </p>
      ) : null}
      {user.profileConflict ? (
        <p className="mb-4 rounded-md border p-3 text-sm">
          {t.admin.detail.profileConflict}
        </p>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="grid gap-8">
          <section className="rounded-lg border bg-card p-4">
            <dl className="divide-y">
              <Field label={t.admin.users.columns.user}>
                {user.name || "—"}
              </Field>
              <Field label={t.admin.users.columns.roles}>
                {user.roles.length === 0
                  ? "—"
                  : user.roles.map((role) => (
                      <Badge key={role} variant="outline" className="mr-1">
                        {role}
                      </Badge>
                    ))}
              </Field>
              <Field label={t.admin.users.columns.created}>
                {user.createdAt.slice(0, 19).replace("T", " ")}
              </Field>
              {user.banned && user.banReason ? (
                <Field label={t.admin.actions.banReason}>
                  {user.banReason}
                </Field>
              ) : null}
            </dl>
          </section>

          <Section title={t.admin.detail.identities}>
            {user.identities.length === 0 ? (
              <Empty>{t.admin.detail.noIdentities}</Empty>
            ) : (
              <ul className="grid gap-1 text-sm">
                {user.identities.map((identity) => (
                  <li key={`${identity.providerId}:${identity.accountId}`}>
                    <span className="font-medium">{identity.providerId}</span>{" "}
                    <span className="text-muted-foreground">
                      {identity.createdAt.slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t.admin.detail.sessions}>
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
                        {session.createdAt.slice(0, 16).replace("T", " ")}
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
          </Section>

          {ui.apiKeysEnabled ? (
            <Section title={t.admin.detail.apiKeys}>
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
                          {key.createdAt.slice(0, 10)}
                        </TableCell>
                        <TableCell className="text-right">
                          <form method="post">
                            <input
                              type="hidden"
                              name="action"
                              value="revoke-key"
                            />
                            <input type="hidden" name="keyId" value={key.id} />
                            <Button type="submit" variant="outline" size="sm">
                              {t.admin.actions.revokeKey}
                            </Button>
                          </form>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>
          ) : null}

          <Section title={t.admin.detail.events}>
            {user.events.length === 0 ? (
              <Empty>{t.admin.detail.noEvents}</Empty>
            ) : (
              <ul className="grid gap-1 text-xs">
                {user.events.map((event) => (
                  <li key={event.id} className="flex flex-wrap gap-2">
                    <span className="text-muted-foreground tabular-nums">
                      {event.createdAt.slice(0, 19).replace("T", " ")}
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
          </Section>
        </div>

        <aside className="grid gap-4">
          <h3 className="text-sm font-medium">{t.admin.actions.title}</h3>

          {user.status === "pending" ? (
            <>
              <Action action="approve" label={t.admin.actions.approve} />
              <form method="post" className="grid gap-2 rounded-lg border p-3">
                <input type="hidden" name="action" value="reject" />
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox name="notify" />
                  {t.admin.detail.notifyRejection}
                </label>
                <Button type="submit" variant="outline">
                  {t.admin.actions.reject}
                </Button>
              </form>
            </>
          ) : null}

          {user.banned ? (
            <Action action="unban" label={t.admin.actions.unban} />
          ) : (
            <form method="post" className="grid gap-2 rounded-lg border p-3">
              <input type="hidden" name="action" value="ban" />
              <Label htmlFor="banReason">{t.admin.actions.banReason}</Label>
              <Input id="banReason" name="banReason" />
              <Label htmlFor="banExpiresIn">
                {t.admin.actions.banDuration}
              </Label>
              <select
                id="banExpiresIn"
                name="banExpiresIn"
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
              >
                {BAN_DURATIONS.map((duration) => (
                  <option key={duration.value} value={duration.value}>
                    {duration.labelKey
                      ? t.admin.actions.banForever
                      : duration.label}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="destructive" disabled={self}>
                {t.admin.actions.ban}
              </Button>
            </form>
          )}

          <form method="post" className="grid gap-2 rounded-lg border p-3">
            <input type="hidden" name="action" value="set-roles" />
            <Label htmlFor="roles">{t.admin.actions.setRoles}</Label>
            <Input
              id="roles"
              name="roles"
              defaultValue={user.roles.join(", ")}
              aria-describedby="roles-help"
            />
            <p id="roles-help" className="text-xs text-muted-foreground">
              {t.admin.actions.setRolesHelp}
            </p>
            <Button type="submit" variant="outline" disabled={self}>
              {t.admin.actions.save}
            </Button>
          </form>

          <Action
            action="revoke-sessions"
            label={t.admin.actions.revokeSessions}
          />

          {user.twoFactorEnabled ? (
            <Action
              action="reset-two-factor"
              label={t.admin.actions.resetTwoFactor}
            />
          ) : null}

          {ui.emailEnabled ? (
            <form method="post" className="rounded-lg border p-3">
              <input type="hidden" name="action" value="send-reset" />
              <input type="hidden" name="email" value={user.email} />
              <Button type="submit" variant="outline" className="w-full">
                {t.admin.actions.sendReset}
              </Button>
            </form>
          ) : null}

          <form method="post" className="grid gap-2 rounded-lg border p-3">
            <input type="hidden" name="action" value="temporary-password" />
            <Label htmlFor="newPassword">
              {t.admin.actions.temporaryPassword}
            </Label>
            <Input
              id="newPassword"
              name="newPassword"
              type="text"
              autoComplete="off"
              aria-describedby="temp-help"
            />
            <p id="temp-help" className="text-xs text-muted-foreground">
              {t.admin.actions.temporaryPasswordHelp}
            </p>
            <Button type="submit" variant="outline">
              {t.admin.actions.save}
            </Button>
          </form>

          <Separator />

          <form method="post" className="grid gap-2 rounded-lg border p-3">
            <input type="hidden" name="action" value="impersonate" />
            <p className="text-xs text-muted-foreground">
              {ui.allowImpersonation
                ? t.admin.actions.impersonateHelp
                : t.admin.actions.impersonateDisabled}
            </p>
            <Button
              type="submit"
              variant="outline"
              disabled={!ui.allowImpersonation || self}
            >
              {t.admin.actions.impersonate}
            </Button>
          </form>

          <form
            method="post"
            className="grid gap-2 rounded-lg border border-destructive/40 p-3"
          >
            <input type="hidden" name="action" value="delete" />
            <p className="text-xs text-muted-foreground">
              {t.admin.actions.deleteConfirm}
            </p>
            <Button type="submit" variant="destructive" disabled={self}>
              {t.admin.actions.delete}
            </Button>
          </form>
        </aside>
      </div>
    </AdminShell>
  )
}

function Action({ action, label }: { action: string; label: string }) {
  return (
    <form method="post" className="rounded-lg border p-3">
      <input type="hidden" name="action" value={action} />
      <Button type="submit" variant="outline" className="w-full">
        {label}
      </Button>
    </form>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <div className="rounded-lg border bg-card p-4">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}
