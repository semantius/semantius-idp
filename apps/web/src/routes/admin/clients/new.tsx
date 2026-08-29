import { Link, createFileRoute } from "@tanstack/react-router"

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
import { claimAdminDraft } from "@/server/functions/admin"
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

const HERE = "/admin/clients/new"
const LIST = "/admin/clients"

/** Both are claimed by the loader, so neither may outlive this render. */
const CONSUMED = ["error", "draft"] as const

/**
 * "Add an application", as a page (**D93**, FR-OIDC-2, **D50**, **D62**).
 *
 * It was a `DialogContent` capped at `sm:max-w-md` with an inner scroller,
 * holding twelve fields including two textareas and a scope fieldset — D64's
 * "an action is a dialog on the page that lists what it acts on",
 * over-generalized. The rule D93 replaces it with is about addressability
 * rather than size: *every create and every edit is a page, because there has
 * to be one address to look at, link to and bookmark; every confirmation stays
 * a modal.*
 *
 * `new` is a static segment and `$clientId` a dynamic one, so this route can
 * never be shadowed by an application whose id is literally `new`.
 *
 * Everything the POST does is D50's and D62's, unchanged: the same
 * read-before-`requireSession` order (**D63**, **D81**), the same `callAuth`,
 * the same `adminErrorCodeFor` (**D70**), the same 303. Two destinations
 * differ — success lands on the **list**, because that is where the new row
 * is and where the secret dialog claims its handle; a refusal comes back
 * **here**, with the draft, because this is the form the values belong to.
 */
export const Route = createFileRoute("/admin/clients/new")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.clients, to: LIST },
        { label: t.admin.clients.add, to: HERE },
      ]),
      error: searchString(search.error),
      // The refused registration, so the fields come back with what was typed
      // rather than empty (**D62**). Claimed, and therefore consumed — which
      // is why `ClaimedParams` strips the handle below.
      draft:
        (await claimAdminDraft({ data: searchString(search.draft) ?? "" })) ??
        undefined,
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.clients.add),
  component: NewClientPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${HERE}`
        const list = `${base}${LIST}`

        // Read before the gate (**D63**, **D81**): a refusal that arrives with
        // the body already in hand can stash the draft, and the error path
        // below does.
        const { fields: form, list: valuesOf } = await readFormMulti(request)

        const signedIn = await requireSession(runtime, request, HERE)
        if (!signedIn.ok) return signedIn.response

        const result = await callAuth(
          runtime,
          "/idp/create-client",
          {
            clientId: form.clientId ?? "",
            name: form.name ?? "",
            type: form.type ?? "spa",
            redirectUris: uriLines(form.redirectUris ?? ""),
            postLogoutRedirectUris: uriLines(form.postLogoutRedirectUris ?? ""),
            scopes: valuesOf("scopes"),
            // The form asks the question the other way round; the wire field
            // is unchanged (round 3, finding 10).
            skipConsent: skipConsentFromForm(form.requireConsent),
            enableEndSession: form.enableEndSession === "on",
          },
          request
        )
        if (!result.ok) {
          // What is left for the server to refuse is a duplicate id, a
          // file-managed collision or a lost race — none of which the form
          // could have known (**D62**). The twelve fields come back rather
          // than being retyped; nothing password-shaped is in there. No
          // `action` discriminator any more: one page, one form, one draft.
          const draft = await stashDraft(runtime, {
            clientId: form.clientId,
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

        const secret =
          typeof result.body.clientSecret === "string"
            ? result.body.clientSecret
            : ""
        if (secret === "") {
          // Nothing to hand over, for one of two reasons, and **which one
          // matters** (**D78**). A public client has no secret at all, and the
          // form's default type is `spa` — so the commonest registration made
          // here produces no secret dialog, and the operator has to be told
          // that is the answer rather than a failure to show one.
          return redirectWithCookies(
            `${list}?notice=${
              result.body.isPublic === true
                ? "clientCreatedPublic"
                : "clientCreated"
            }`
          )
        }
        const handle = await stash(runtime, secret, { ttlSeconds: 600 })
        return redirectWithCookies(`${list}?created=${handle}`)
      },
    },
  },
})

function NewClientPage() {
  const { ui, error, draft } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const { onSubmit, errors } = useClientForm()
  const values = resolveClientFormValues(draft, {
    name: "",
    clientId: "",
    type: "spa",
    redirectUris: "",
    postLogoutRedirectUris: "",
    // Every scope this deployment allows, ticked: an operator adding an
    // application is describing what it may ask for, and starting from none
    // means a client that can request nothing.
    scopes: [...ui.oauthScopes],
    requireConsent: false,
    enableEndSession: false,
  })

  return (
    <AdminShell
      title={t.admin.clients.add}
      description={t.admin.clients.addHelp}
    >
      {/* The draft is single-use, so leaving its handle and the error in the
          address bar would make a reload render twelve empty fields under a
          live message about values that are gone (**D93**). */}
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
        <ClientFormFields ui={ui} t={t} values={values} errors={errors} />
        {/* Cancel then Save, left to right, at the end of the form. **No
            sticky bar, and never a second Save in `AdminShell`'s actions
            slot**: two submit buttons for one form is worse than one below
            the fold, and with the fields in three cards a page is allowed to
            scroll to its Save. */}
        <div className="flex flex-wrap justify-end gap-2">
          <Link
            to="/admin/clients"
            className={buttonVariants({ variant: "outline" })}
          >
            {t.common.cancel}
          </Link>
          <SubmitButton>{t.admin.clients.add}</SubmitButton>
        </div>
      </GuardedForm>
    </AdminShell>
  )
}
