import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import { readForm, redirectWithCookies } from "@/server/http/auth-proxy"
import { APP_ROUTES, createBasePaths } from "@/server/oidc/base-path"
import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * The confirmation an RP-initiated logout needs when it cannot prove itself
 * (FR-OIDC-11).
 *
 * `/oauth2/end-session` sends the browser here when the request carries no
 * `id_token_hint`. Without a hint there is nothing to say the request came
 * from a client the user was signed in to, and a GET that ends a session lets
 * any page sign a user out with an `<img>` tag. So this asks, and the answer
 * is a POST.
 *
 * The original query is carried through untouched and handed back to the
 * provider, which is what still validates `post_logout_redirect_uri` and
 * echoes `state` — this page decides nothing about where the user goes.
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
      query: location.searchStr,
    }
  },
  component: SignOutPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const paths = createBasePaths(runtime.config.base)
        const form = await readForm(request)

        if (form.decision !== "confirm") {
          return redirectWithCookies(`${paths.basePath}${APP_ROUTES.account}`)
        }

        const query = form.query ?? ""
        return forwardToAuth(
          runtime,
          new Request(`${paths.origin}${APP_ROUTES.endSession}${query}`, {
            headers: request.headers,
            redirect: "manual",
          }),
          { providerPath: "/oauth2/end-session" }
        )
      },
    },
  },
})

function SignOutPage() {
  const { ui, clientId, query } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  return (
    <AuthShell
      ui={ui}
      title={t.endSession.title}
      description={t.endSession.description(clientId ?? ui.siteName)}
    >
      <form method="post" className="grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="query" value={query} />
        <Button type="submit" name="decision" value="cancel" variant="outline">
          {t.endSession.cancel}
        </Button>
        <Button type="submit" name="decision" value="confirm">
          {t.endSession.confirm}
        </Button>
      </form>
    </AuthShell>
  )
}
