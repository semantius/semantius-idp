import { Link, createFileRoute } from "@tanstack/react-router"

import { buttonVariants } from "@workspace/ui/components/button"

import { AdminCard, AdminShell } from "@/components/admin/admin-shell"
import {
  GatewayFormFields,
  resolveGatewayFormValues,
  useGatewayForm,
} from "@/components/admin/gateway-form-fields"
import { FormRefusal } from "@/components/auth/form-parts"
import { crumbTrail } from "@/components/common/breadcrumbs"
import { ClaimedParams } from "@/components/common/claimed-params"
import { GuardedForm } from "@/components/common/guarded-form"
import { SubmitButton } from "@/components/common/pending-form"
import { messageForErrorCode } from "@/lib/auth-errors"
import { adminHead } from "@/lib/page-title"
import { searchString } from "@/lib/search-params"
import { claimAdminDraft } from "@/server/functions/admin"
import { getCatalog } from "@/server/i18n"
import {
  adminErrorCodeFor,
  callAuth,
  readForm,
  redirectWithCookies,
  withError,
} from "@/server/http/auth-proxy"
import { stashDraft, withDraft } from "@/server/http/draft"
import { requireSession } from "@/server/http/require-session"
import { getRuntime } from "@/server/runtime"

const HERE = "/admin/gateways/new"
const LIST = "/admin/gateways"

/** Both are claimed by the loader, so neither may outlive this render. */
const CONSUMED = ["error", "draft"] as const

/**
 * "Add a gateway", as a page (**D93**, FR-GW-7, **D91**).
 *
 * The client pages carry the argument; this one follows it, because the rule
 * is about addressability rather than size and a four-field form is not an
 * exception to it. What is worth saying here is what did *not* change: the
 * browser still refuses exactly what `config.jsonc` would, from the shared
 * rules in `lib/gateway-rules.ts` that the zod schema also calls (**D62**),
 * and the server still refuses everything again.
 *
 * Success lands on the list, a refusal comes back here with the draft.
 */
export const Route = createFileRoute("/admin/gateways/new")({
  loader: async ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.gateways, to: LIST },
        { label: t.admin.gateways.add, to: HERE },
      ]),
      error: searchString(search.error),
      draft:
        (await claimAdminDraft({ data: searchString(search.draft) ?? "" })) ??
        undefined,
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.gateways.add),
  component: NewGatewayPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const here = `${base}${HERE}`
        const list = `${base}${LIST}`

        // Read before the gate (**D63**, **D81**).
        const form = await readForm(request)

        const signedIn = await requireSession(runtime, request, HERE)
        if (!signedIn.ok) return signedIn.response

        const result = await callAuth(
          runtime,
          "/idp/create-gateway",
          {
            name: form.name ?? "",
            url: form.url ?? "",
            requireAuth: form.requireAuth === "on",
          },
          request
        )
        if (!result.ok) {
          // A duplicate name or a lost race — nothing the form could have
          // known (**D62**). No `action` discriminator: one page, one draft.
          const draft = await stashDraft(runtime, {
            name: form.name,
            url: form.url,
            requireAuth: form.requireAuth,
          })
          return redirectWithCookies(
            withError(withDraft(here, draft), adminErrorCodeFor(result))
          )
        }

        return redirectWithCookies(`${list}?notice=gatewayCreated`)
      },
    },
  },
})

function NewGatewayPage() {
  const { ui, error, draft } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const { onSubmit, errors } = useGatewayForm()
  const values = resolveGatewayFormValues(draft, {
    name: "",
    url: "",
    // Off by default: PostgREST and the Neon Data API both have an anonymous
    // role, so anonymous reach is the ordinary case and `requireAuth` is the
    // exception an operator opts into (FR-GW-4).
    requireAuth: false,
  })

  return (
    <AdminShell
      title={t.admin.gateways.add}
      description={t.admin.gateways.addHelp}
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
        {/* One untitled card rather than the client form's three: four fields
            are not a wall, and a bare stack of inputs on a full-width page
            reads as adrift. */}
        <AdminCard className="gap-4">
          <GatewayFormFields t={t} values={values} errors={errors} />
        </AdminCard>
        <div className="flex flex-wrap justify-end gap-2">
          <Link
            to="/admin/gateways"
            className={buttonVariants({ variant: "outline" })}
          >
            {t.common.cancel}
          </Link>
          <SubmitButton>{t.admin.gateways.add}</SubmitButton>
        </div>
      </GuardedForm>
    </AdminShell>
  )
}
