import { Link, createFileRoute, redirect } from "@tanstack/react-router"

import { buttonVariants } from "@workspace/ui/components/button"

import { AdminShell } from "@/components/admin/admin-shell"
import {
  ClientFormFields,
  resolveClientFormValues,
  useClientForm,
} from "@/components/admin/client-form-fields"
import { FormRefusal } from "@/components/auth/form-parts"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { ClaimedParams } from "@/components/common/claimed-params"
import { GuardedForm } from "@/components/common/guarded-form"
import { SubmitButton } from "@/components/common/pending-form"
import { messageForErrorCode } from "@/lib/auth-errors"
import { skipConsentFromForm, uriLines } from "@/lib/client-rules"
import { adminHead } from "@/lib/page-title"
import { searchString } from "@/lib/search-params"
import { claimAdminDraft, fetchClients } from "@/server/functions/admin"
import { getCatalog } from "@/server/i18n"
import {
  adminErrorCodeFor,
  callAuth,
  readFormMulti,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { stashDraft, withDraft } from "@/server/http/draft"
import { stash } from "@/server/http/one-shot"
import { requireSession } from "@/server/http/require-session"
import { getRuntime } from "@/server/runtime"

const LIST = "/admin/clients"

/** Both are claimed by the loader, so neither may outlive this render. */
const CONSUMED = ["error", "draft"] as const

/**
 * "Edit the application", as a page (**D93**, **D72**, FR-OIDC-2, FR-ADMIN-2).
 *
 * Three symptoms of D64's over-generalization went away with the dialog this
 * replaces, and each had been patched rather than diagnosed: the `max-h`
 * override in `dialogs.tsx` — added because the client form's submit button
 * became unclickable the moment it grew two checkboxes and a second textarea —
 * one whole twelve-field form rendered **per table row**, and the
 * `action`+`clientId` discriminator that existed only to decide *which* row's
 * dialog reopened after a refusal. One address, one form, one draft.
 *
 * `$clientId/edit` rather than `$clientId`: an application whose id is
 * literally `new` stays reachable, and there is room for a detail page later
 * without moving this one.
 *
 * **A file-managed row is refused with a redirect, not `notFound()`.** The
 * write would be undone by the next restart (FR-OIDC-2, **D50**), so it must
 * not happen — but `notFound()` is a `min-h-svh` centred page with no sidebar
 * and no link out (`__root.tsx`), replying "this does not exist" about a row
 * that was visible on the previous screen. The list with a reason is the shape
 * every other refusal on that page already uses.
 */
export const Route = createFileRoute("/admin/clients/$clientId/edit")({
  loader: async ({ context, params, location }) => {
    const search = location.search as Record<string, unknown>
    const clients = (await fetchClients()) ?? []
    const client = clients.find((row) => row.clientId === params.clientId)
    if (!client || client.managedBy === "file") {
      throw redirect({
        to: LIST,
        search: { error: client ? "client_managed_by_file" : "client_not_found" },
      })
    }
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.clients, to: LIST },
        // The trail ends at the record; the `<h1>` names the operation, so
        // nothing is said twice and the verb has an object (**D93**).
        { label: client.name },
      ]),
      client,
      error: searchString(search.error),
      draft:
        (await claimAdminDraft({ data: searchString(search.draft) ?? "" })) ??
        undefined,
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.clients.editTitle),
  component: EditClientPage,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        // `encodeURIComponent`, because the id is an operator's string in a
        // path segment. `validateClientForm` refuses `.` and `..` — the two
        // values a browser would resolve away before the request left it
        // (**D93**) — and this covers everything else the character rule
        // allows through.
        const here = `${base}/admin/clients/${encodeURIComponent(
          params.clientId
        )}/edit`
        const list = `${base}${LIST}`

        // Read before the gate (**D63**, **D81**).
        const { fields: form, list: valuesOf } = await readFormMulti(request)

        const signedIn = await requireSession(runtime, request, here)
        if (!signedIn.ok) return signedIn.response

        // Create and update marshal identically — `/idp/update-client` takes
        // create's body, because a full replace *is* a create against a row
        // that already exists (**D72**). The `clientId` comes from the path,
        // not the form: the field is display-only here.
        const result = await callAuth(
          runtime,
          "/idp/update-client",
          {
            clientId: params.clientId,
            name: form.name ?? "",
            type: form.type ?? "spa",
            redirectUris: uriLines(form.redirectUris ?? ""),
            postLogoutRedirectUris: uriLines(form.postLogoutRedirectUris ?? ""),
            scopes: valuesOf("scopes"),
            skipConsent: skipConsentFromForm(form.requireConsent),
            enableEndSession: form.enableEndSession === "on",
          },
          request
        )
        if (!result.ok) {
          const draft = await stashDraft(runtime, {
            name: form.name,
            type: form.type,
            redirectUris: form.redirectUris,
            postLogoutRedirectUris: form.postLogoutRedirectUris,
            scopes: valuesOf("scopes"),
            requireConsent: form.requireConsent,
            enableEndSession: form.enableEndSession,
          })
          return redirectWithCookies(
            withError(withDraft(here, draft), adminErrorCodeFor(result))
          )
        }

        // A type change from public to Web mints a secret, and it is shown
        // once on the list, through the same one-shot stash a creation uses
        // (**D78**). An update that kept the existing secret shows nothing:
        // the row holds a hash.
        const secret =
          typeof result.body.clientSecret === "string"
            ? result.body.clientSecret
            : ""
        if (secret === "") {
          return redirectWithCookies(
            `${list}?notice=${
              result.body.isPublic === true
                ? "clientUpdatedPublic"
                : "clientUpdated"
            }`
          )
        }
        const handle = await stash(runtime, secret, { ttlSeconds: 600 })
        return redirectWithCookies(`${list}?created=${handle}`)
      },
    },
  },
})

function EditClientPage() {
  const { ui, client, error, draft } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const { onSubmit, errors } = useClientForm()
  // Draft first, then the row: a refused edit comes back with what was typed
  // (**D62**), and an untouched form shows what is stored. Both matter,
  // because `/idp/update-client` is a full replace — an unprefilled field is a
  // field that saving clears.
  const values = resolveClientFormValues(draft, {
    name: client.name,
    clientId: client.clientId,
    type: client.type,
    redirectUris: client.redirectUris.join("\n"),
    postLogoutRedirectUris: client.postLogoutRedirectUris.join("\n"),
    scopes: [...client.scopes],
    // The inversion of the stored `skipConsent`, and it is inverted **only
    // here on the way in and in `skipConsentFromForm` on the way out**. Two
    // inversions in two places is how a triple negative gets shipped.
    requireConsent: !client.skipConsent,
    enableEndSession: client.enableEndSession,
  })

  return (
    <AdminShell
      title={t.admin.clients.editTitle}
      description={t.admin.clients.editHelp}
    >
      <ClaimedParams names={CONSUMED} />
      <FormRefusal>
        {messageForErrorCode(error, t, ui.passwordMinLength)}
      </FormRefusal>

      <GuardedForm
        t={t}
        busy={t.common.loading}
        method="post"
        className="grid max-w-3xl gap-6"
        onSubmit={onSubmit}
      >
        <ClientFormFields
          ui={ui}
          t={t}
          values={values}
          errors={errors}
          fixedClientId
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Link
            to="/admin/clients"
            className={buttonVariants({ variant: "outline" })}
          >
            {t.common.cancel}
          </Link>
          {/* `admin.actions.save` ("Save"), not `common.save` ("Save
              changes"): every other write in this area is labelled the first
              way. */}
          <SubmitButton>{t.admin.actions.save}</SubmitButton>
        </div>
      </GuardedForm>
    </AdminShell>
  )
}
