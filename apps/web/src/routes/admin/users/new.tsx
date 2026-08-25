import { Link, createFileRoute } from "@tanstack/react-router"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"

import { AdminShell } from "@/components/admin/admin-shell"
import { RoleCheckboxes } from "@/components/admin/role-checkboxes"
import { FormAlert } from "@/components/auth/form-parts"
import { messageForErrorCode } from "@/lib/auth-errors"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  errorCodeFor,
  readFormMulti,
  redirectWithCookies,
} from "@/server/http/auth-proxy"
import { requireFreshSession } from "@/server/http/fresh-session"
import { stash } from "@/server/http/one-shot"
import { createResetLink } from "@/server/auth/reset-link"
import { displayName } from "@/server/display-name"
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
 * link; with e-mail off (FR-MAIL-2) the same one-time link is handed over on
 * screen *once*, because a server that cannot send mail still has to be able to
 * onboard somebody — and an administrator typing a password into a form is a
 * password that exists in two heads and a browser history.
 *
 * **Both outcomes land on `/admin/users`** (D51 review, item 10). The account
 * that was just created belongs in the list it was created for; the previous
 * arrangement sent one outcome to the new user's detail page and left the other
 * on this form with a link rendered underneath it, so "create three users" was
 * three round trips through a page nobody wanted to be on.
 *
 * And the link no longer travels in the URL. It is stashed server-side
 * (`server/http/one-shot.ts`) and the redirect carries a handle the list claims
 * — a one-time password-setting URL in a query string is a one-time
 * password-setting URL in browser history and in every proxy log on the way.
 */
export const Route = createFileRoute("/admin/users/new")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      gate: context.gate,
      roles: (await fetchRoles()) ?? [],
      error: searchString(search.error),
    }
  },
  component: CreateUserPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}/admin/users/new`
        const list = `${base}/admin/users`

        const fresh = await requireFreshSession(runtime, request, here)
        if (!fresh.ok) return fresh.response

        // Roles are checkboxes, so the field repeats; `readForm` keeps only
        // the last value of a repeated key, which would silently drop every
        // role but one.
        const { fields: form, list: valuesOf } = await readFormMulti(request)
        const email = (form.email ?? "").trim()
        const firstName = form.firstName ?? ""
        const lastName = form.lastName ?? ""
        const roles = valuesOf("roles")

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
          return redirectWithCookies(`${list}?notice=created`)
        }

        // FR-MAIL-2: nothing can be sent, so the link is handed over on screen
        // — once, in a dialog on the list, and never in the address bar.
        const handle = await stash(runtime, reset.url, { ttlSeconds: 600 })
        return redirectWithCookies(`${list}?created=${handle}`)
      },
    },
  },
})

function CreateUserPage() {
  const { ui, gate, roles, error } = Route.useLoaderData()
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

      <form method="post" className="grid max-w-md gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="firstName">{t.common.firstName}</Label>
            <Input id="firstName" name="firstName" autoComplete="off" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="lastName">{t.common.lastName}</Label>
            <Input id="lastName" name="lastName" autoComplete="off" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="email">{t.admin.create.email}</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <RoleCheckboxes roles={roles} legend={t.admin.create.roles} />
        <Button type="submit">{t.admin.create.submit}</Button>
      </form>
    </AdminShell>
  )
}
