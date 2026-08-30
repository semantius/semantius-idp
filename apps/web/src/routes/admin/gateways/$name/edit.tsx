import { Link, createFileRoute, redirect } from "@tanstack/react-router"

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
import { claimAdminDraft, fetchGateways } from "@/server/functions/admin"
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

const LIST = "/admin/gateways"

/** Both are claimed by the loader, so neither may outlive this render. */
const CONSUMED = ["error", "draft"] as const

/**
 * "Edit the gateway", as a page (**D93**, FR-GW-7, **D91**, **D92**).
 *
 * **The target is not prefilled when it is masked.** `fetchGateways` returns
 * the stored string byte for byte unless it carries a password, and says so in
 * `urlMasked` — because `/idp/update-gateway` is a full replace, so prefilling
 * the masked projection would offer `***` back as the value to store. Only
 * reachable for a row written by hand in `psql`: `checkGatewayUrl` refuses
 * userinfo on every write path.
 *
 * A config-owned row is refused with a redirect to the list carrying a reason,
 * never with `notFound()` — see `/admin/clients/$clientId/edit` for why.
 */
export const Route = createFileRoute("/admin/gateways/$name/edit")({
  loader: async ({ context, params, location }) => {
    const search = location.search as Record<string, unknown>
    const gateways = (await fetchGateways()) ?? []
    const gateway = gateways.find((row) => row.name === params.name)
    if (!gateway || gateway.source === "config") {
      throw redirect({
        to: LIST,
        search: {
          error: gateway ? "gateway_managed_by_file" : "gateway_not_found",
        },
      })
    }
    return {
      ui: context.ui,
      crumbs: crumbTrail(context.ui, (t) => [
        { label: t.admin.nav.gateways, to: LIST },
        { label: gateway.name },
      ]),
      gateway,
      error: searchString(search.error),
      draft:
        (await claimAdminDraft({ data: searchString(search.draft) ?? "" })) ??
        undefined,
    }
  },
  head: ({ loaderData }) =>
    adminHead(loaderData?.ui, (t) => t.admin.gateways.editTitle),
  component: EditGatewayPage,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        // `isValidGatewayName` already refuses everything that is not a plain
        // lower-case path segment — no dots, no slashes, no percent-encoding
        // (**D91**) — so this is belt to the rule's braces rather than the
        // rule itself.
        const here = `${base}/admin/gateways/${encodeURIComponent(
          params.name
        )}/edit`
        const list = `${base}${LIST}`

        const form = await readForm(request)

        const signedIn = await requireSession(runtime, request, here)
        if (!signedIn.ok) return signedIn.response

        // `/idp/update-gateway` takes create's body, because a full replace
        // *is* a create against a row that already exists (**D72**'s shape).
        // The name comes from **the path**, never from the form — the form
        // carries a hidden one for the browser-side rule to read, and this is
        // what keeps the two from disagreeing about which row is being
        // changed.
        const result = await callAuth(
          runtime,
          "/idp/update-gateway",
          {
            name: params.name,
            url: form.url ?? "",
            requireAuth: form.requireAuth === "on",
          },
          request
        )
        if (!result.ok) {
          const draft = await stashDraft(runtime, {
            url: form.url,
            requireAuth: form.requireAuth,
          })
          return redirectWithCookies(
            withError(withDraft(here, draft), adminErrorCodeFor(result))
          )
        }

        return redirectWithCookies(`${list}?notice=gatewayUpdated`)
      },
    },
  },
})

function EditGatewayPage() {
  const { ui, gateway, error, draft } = Route.useLoaderData()
  const t = getCatalog(ui.locale)
  const { onSubmit, errors } = useGatewayForm()
  const values = resolveGatewayFormValues(draft, {
    name: gateway.name,
    // Empty rather than `***`. See the note at the top of the file: the field
    // is a full replace and the masked value is a lossy projection, so the
    // only honest prefill is none — with a sentence saying to retype it.
    url: gateway.urlMasked ? "" : gateway.url,
    requireAuth: gateway.requireAuth,
  })

  return (
    <AdminShell
      title={t.admin.gateways.editTitle}
      description={t.admin.gateways.editHelp}
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
        <AdminCard className="gap-4">
          <GatewayFormFields
            t={t}
            values={values}
            errors={errors}
            fixedName
            urlMasked={gateway.urlMasked}
          />
        </AdminCard>
        <div className="flex flex-wrap justify-end gap-2">
          <Link
            to="/admin/gateways"
            className={buttonVariants({ variant: "outline" })}
          >
            {t.common.cancel}
          </Link>
          <SubmitButton>{t.admin.actions.save}</SubmitButton>
        </div>
      </GuardedForm>
    </AdminShell>
  )
}
