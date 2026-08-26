import { createFileRoute } from "@tanstack/react-router"

import { buttonVariants } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import { APP_ROUTES, AUTH_BASE_PATH } from "@/server/oidc/base-path"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"

/**
 * The confirmation an RP-initiated logout needs when it cannot prove itself
 * (FR-OIDC-11).
 *
 * `/oauth2/end-session` sends the browser here whenever the provider decides
 * to ask — no `id_token_hint`, an expired one, or a hint naming a session
 * other than this browser's. Without proof, a GET that ends a session lets any
 * page sign a user out with an `<img>` tag, so it asks, and the answer is a
 * POST.
 *
 * **This page asks; the provider decides.** The form posts straight to the
 * provider's own confirmation endpoint, which is the only thing that can
 * finish the job: the page `/oauth2/end-session` produced set a signed,
 * short-lived state cookie scoped to *that* path, and it holds the client, the
 * `post_logout_redirect_uri` and the `state` the provider will echo. A cookie
 * scoped to `…/oauth2/end-session/confirm` is not sent anywhere else, so an
 * earlier version of this page — which posted back to itself and forwarded
 * the request server-side — could never have worked, and did not: the answer
 * was always "the logout confirmation is invalid or expired". Nothing noticed,
 * because until M13 nothing had ever driven an RP-initiated logout.
 *
 * So what stays here is the *question*, in this deployment's own words and on
 * its own pages, instead of the unbranded HTML the library would otherwise
 * serve (D47). Cancelling is a link, because declining changes nothing.
 *
 * Distinct from `/logout`, which is the user's own "sign me out" and answers
 * to nobody's redirect (FR-AUTH-6).
 */
export const Route = createFileRoute("/sign-out")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      clientId: searchString(search.client_id),
    }
  },
  component: SignOutPage,
})

function SignOutPage() {
  const { ui, clientId } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AuthShell
      ui={ui}
      title={t.endSession.title}
      description={t.endSession.description(clientId ?? ui.siteName)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <a
          href={`${ui.basePath}${APP_ROUTES.account}`}
          className={buttonVariants({ variant: "outline" })}
        >
          {t.endSession.cancel}
        </a>
        <PendingForm
          busy={t.common.loading}
          method="post"
          action={`${ui.basePath}${AUTH_BASE_PATH}/oauth2/end-session/confirm`}
        >
          <input type="hidden" name="action" value="confirm" />
          <SubmitButton className="w-full">{t.endSession.confirm}</SubmitButton>
        </PendingForm>
      </div>
    </AuthShell>
  )
}
