import { Link, createFileRoute } from "@tanstack/react-router"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"

import { AdminShell } from "@/components/admin/admin-shell"
import { FormAlert } from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readForm,
  redirectWithCookies,
} from "@/server/http/auth-proxy"
import { requireFreshSession } from "@/server/http/fresh-session"
import { createResetLink } from "@/server/auth/reset-link"
import { fetchRoles } from "@/server/functions/admin"
import { getRuntime } from "@/server/runtime"

/**
 * `/admin/users/new` — create an account on someone's behalf (FR-ADMIN-2).
 *
 * Created **approved and confirmed**: an administrator typing the address is
 * the vouching that the approval queue and the verification e-mail exist to
 * obtain, and making them then approve their own creation would be a step that
 * teaches people to click through steps.
 *
 * The password is never chosen here. With e-mail on, they get a `setPassword`
 * link; with e-mail off (FR-MAIL-2) the same one-time link is shown on screen
 * *once*, because a server that cannot send mail still has to be able to
 * onboard somebody — and an administrator typing a password into a form is a
 * password that exists in two heads and a browser history.
 */
export const Route = createFileRoute("/admin/users/new")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      gate: context.gate,
      roles: (await fetchRoles()) ?? [],
      error: searchString(search.error),
      link: searchString(search.link),
    }
  },
  component: CreateUserPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}/admin/users/new`

        const fresh = await requireFreshSession(runtime, request, here)
        if (!fresh.ok) return fresh.response

        const form = await readForm(request)
        const email = (form.email ?? "").trim()
        const roles = (form.roles ?? "")
          .split(",")
          .map((role) => role.trim())
          .filter((role) => role !== "")

        const created = await callAuth(
          runtime,
          "/admin/create-user",
          {
            email,
            name: form.name ?? "",
            // A random password nobody will ever use: the account is reached
            // through the set-password link, and a null password would make it
            // a social-only account, which is not what was asked for.
            password: crypto.randomUUID() + crypto.randomUUID(),
            ...(roles.length ? { role: roles } : {}),
            data: { status: "active", emailVerified: true },
          },
          request
        )
        if (!created.ok) {
          const query = new URLSearchParams({ error: errorCodeFor(created) })
          return redirectWithCookies(`${here}?${query.toString()}`)
        }

        const user = created.body.user as { id?: string } | undefined
        await runtime.audit.record({
          action: "signup.created",
          outcome: "success",
          actorType: "session",
          actorUserId: fresh.session.user.id,
          target: { type: "user", id: user?.id ?? email },
          metadata: { by: "admin", roles },
        })

        const reset = await createResetLink(runtime, user?.id ?? "")

        if (runtime.mailer.enabled) {
          await runtime.mailer.send("setPassword", email, { url: reset.url })
          const query = new URLSearchParams({ notice: "created" })
          return redirectWithCookies(
            `${base}/admin/users/${encodeURIComponent(user?.id ?? "")}?${query.toString()}`
          )
        }

        // FR-MAIL-2: nothing can be sent, so the link is handed over on screen
        // — once, on the next render of this page, and never stored.
        const query = new URLSearchParams({ link: reset.url })
        return redirectWithCookies(`${here}?${query.toString()}`)
      },
    },
  },
})

function CreateUserPage() {
  const { ui, gate, roles, error, link } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const impersonated = gate.admin ? gate.impersonated : false

  return (
    <AdminShell
      ui={ui}
      t={t}
      title={t.admin.create.title}
      description={t.admin.create.description}
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

      {link ? (
        <section className="mb-6 rounded-lg border p-4">
          <h3 className="text-sm font-medium">{t.admin.create.linkTitle}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.admin.create.linkHelp}
          </p>
          <code className="mt-2 block rounded bg-muted p-2 text-xs break-all">
            {link}
          </code>
        </section>
      ) : null}

      <form method="post" className="grid max-w-md gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="email">{t.admin.create.email}</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="name">{t.admin.create.name}</Label>
          <Input id="name" name="name" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="roles">{t.admin.create.roles}</Label>
          <Input
            id="roles"
            name="roles"
            placeholder={roles.map((role) => role.name).join(", ")}
          />
        </div>
        <Button type="submit">{t.admin.create.submit}</Button>
      </form>
    </AdminShell>
  )
}
