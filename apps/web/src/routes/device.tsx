import { createFileRoute, notFound, redirect } from "@tanstack/react-router"

import { AuthShell } from "@/components/auth/auth-shell"
import { FormAlert, FormRefusal, TextField } from "@/components/auth/form-parts"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { searchString } from "@/lib/search-params"
import { fetchDeviceRequest } from "@/server/functions/device"
import type { DeviceRefusal } from "@/server/functions/device"
import { getCatalog } from "@/server/i18n"
import type { Catalog } from "@/server/i18n"
import { callAuth, readForm, redirectWithCookies } from "@/server/http/auth-proxy"
import {
  decidedClient,
  deviceRefusalFor,
} from "@/server/http/device-decision"
import { requireSession } from "@/server/http/require-session"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

const REFUSALS: readonly DeviceRefusal[] = [
  "invalid",
  "expired",
  "used",
  "otherAccount",
  "tooMany",
]

/**
 * `/device` — where somebody approves a sign-in they started on a machine with
 * no browser (RFC 8628's verification URI).
 *
 * **Sign-in comes first, always.** A code is claimed by the first signed-in
 * user who looks it up (`server/functions/device.ts`), so the page never looks
 * one up anonymously; it sends the visitor through `/login` — and with it the
 * whole gate chain: approval status, the second factor, a forced password
 * change — and back here with the code still in the address.
 *
 * **The confirmation is never skipped**, whatever the client's `skipConsent`
 * says. The attack this grant has is a code started by somebody else and
 * handed over — "enter this code to fix your account" — and the only point
 * at which that can be noticed is this screen, so it names the application,
 * the account, and says in words what approving does. A client an
 * administrator trusted enough to skip consent for is still a client somebody
 * else can start a sign-in for.
 *
 * Absent — `notFound()` — when `oauth.deviceAuthorization.enabled` is off, as
 * the endpoints are.
 */
export const Route = createFileRoute("/device")({
  loader: async ({ context, location }) => {
    if (!context.ui.deviceAuthorization) throw notFound()

    const search = location.search as Record<string, unknown>
    const done = searchString(search.done)
    if (done === "approved" || done === "denied") {
      return {
        ui: context.ui,
        view: { state: "done" as const, done },
        error: undefined,
      }
    }

    const userCode = searchString(search.user_code) ?? ""
    const here =
      userCode === ""
        ? APP_ROUTES.device
        : `${APP_ROUTES.device}?${new URLSearchParams({ user_code: userCode }).toString()}`

    const lookup = await fetchDeviceRequest({ data: userCode })
    if (lookup.state === "signedOut") {
      throw redirect({
        to: APP_ROUTES.login,
        search: { notice: "signin_required", returnTo: here },
      })
    }
    if (lookup.state === "forcedChange") {
      throw redirect({
        to: APP_ROUTES.changePassword,
        search: { forced: "1", returnTo: here },
      })
    }

    // A refusal from the approve/deny post comes back as `?error=`; one from
    // the lookup is in `lookup` itself. Either way it is a code, never text.
    const posted = searchString(search.error)
    const error = REFUSALS.find((reason) => reason === posted)
    return { ui: context.ui, view: lookup, error }
  },
  component: DevicePage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath
        const form = await readForm(request)
        const userCode = form.userCode ?? ""
        const approve = form.decision === "allow"
        const here = `${APP_ROUTES.device}?${new URLSearchParams({ user_code: userCode }).toString()}`

        // Same-origin, a live session read from the row, no forced change
        // pending — the checks every form post here gets.
        const signedIn = await requireSession(runtime, request, here)
        if (!signedIn.ok) return signedIn.response

        const result = await callAuth(
          runtime,
          approve ? "/device/approve" : "/device/deny",
          { userCode },
          request
        )
        if (!result.ok) {
          return redirectWithCookies(
            `${base}${here}&error=${deviceRefusalFor(result.status, result.body)}`
          )
        }

        // The client on the trail is the one the plugin bound to this code,
        // read back from the row it just decided — never a form field, which
        // is how the consent page once recorded a consent for whatever client
        // the browser named.
        await runtime.audit.record({
          action: "device.authorized",
          outcome: approve ? "success" : "denied",
          actorType: "session",
          actorUserId: signedIn.session.user.id,
          metadata: {
            clientId: await decidedClient(
              runtime,
              userCode,
              signedIn.session.user.id
            ),
          },
        })

        return redirectWithCookies(
          `${base}${APP_ROUTES.device}?done=${approve ? "approved" : "denied"}`
        )
      },
    },
  },
})

function DevicePage() {
  const data = Route.useLoaderData()
  const t = getCatalog(data.ui.locale)
  const view = data.view

  if (view.state === "done") {
    const approved = view.done === "approved"
    return (
      <AuthShell
        ui={data.ui}
        title={approved ? t.device.approvedTitle : t.device.deniedTitle}
        description={
          approved ? t.device.approvedDescription : t.device.deniedDescription
        }
      >
        {null}
      </AuthShell>
    )
  }

  if (view.state === "confirm") {
    const request = view.request
    return (
      <AuthShell
        ui={data.ui}
        title={t.device.confirmTitle(request.clientName)}
        description={t.device.confirmDescription(view.email)}
      >
        <FormRefusal>{refusalMessage(t, data.error)}</FormRefusal>
        {/* Not a live region and not dismissible: it is the reason the page
            exists, and it has to be read before the buttons, not announced
            over them. */}
        <FormAlert variant="default">{t.device.warning}</FormAlert>
        <p className="mb-4 font-mono text-sm">
          {t.device.codeShown(request.userCode)}
        </p>
        <ul className="mb-6 grid gap-2 text-sm">
          {request.scopes.map((scope) => (
            <li key={scope} className="flex gap-2">
              <span aria-hidden="true">·</span>
              <span>
                {t.consent.scopes[scope] ?? t.consent.unknownScope(scope)}
              </span>
            </li>
          ))}
        </ul>
        {/* Deny first, as on the consent page: the safe answer is the one
            nearest the start of the reading order. */}
        <PendingForm
          busy={t.common.loading}
          method="post"
          className="grid gap-3 sm:grid-cols-2"
        >
          <input type="hidden" name="userCode" value={request.userCode} />
          <SubmitButton name="decision" value="deny" variant="outline">
            {t.device.deny}
          </SubmitButton>
          <SubmitButton name="decision" value="allow">
            {t.device.allow}
          </SubmitButton>
        </PendingForm>
      </AuthShell>
    )
  }

  // Signed in, and either no code yet or one that cannot be approved: the
  // entry form, with the reason above it. A GET form, so the code lands in
  // the address exactly as a `verification_uri_complete` link puts it there.
  const refusal =
    view.state === "refused" ? view.reason : (data.error ?? undefined)
  return (
    <AuthShell
      ui={data.ui}
      title={t.device.title}
      description={t.device.description}
    >
      <FormRefusal>{refusalMessage(t, refusal)}</FormRefusal>
      <PendingForm busy={t.common.loading} method="get" className="grid gap-4">
        <TextField
          name="user_code"
          label={t.device.codeLabel}
          autoComplete="one-time-code"
          defaultValue={view.state === "refused" ? view.userCode : undefined}
          autoFocus
        />
        <SubmitButton className="w-full">{t.device.continue}</SubmitButton>
      </PendingForm>
    </AuthShell>
  )
}

function refusalMessage(
  t: Catalog,
  reason: DeviceRefusal | undefined
): string | undefined {
  switch (reason) {
    case "invalid":
      return t.device.invalidCode
    case "expired":
      return t.device.expiredCode
    case "used":
      return t.device.alreadyUsed
    case "otherAccount":
      return t.device.otherAccount
    case "tooMany":
      return t.device.tooManyAttempts
    default:
      return undefined
  }
}
