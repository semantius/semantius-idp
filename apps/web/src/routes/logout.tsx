import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { AuthShell } from "@/components/auth/auth-shell"
import { searchString } from "@/lib/search-params"
import { getCatalog } from "@/server/i18n"
import {
  callAuth,
  redirectWithCookies,
  safeReturnTo,
} from "@/server/http/auth-proxy"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { getRuntime } from "@/server/runtime"

/**
 * `/logout` (FR-AUTH-6).
 *
 * **POST only** for the actual sign-out. A GET that ended a session would let
 * any page log a user out with an `<img>` tag, so the GET renders a button
 * instead — which also gives the "signed out" confirmation somewhere to live.
 *
 * `returnTo` must be a same-origin relative path (SEC-3). RP-initiated logout
 * is a different thing entirely and lives at `/oauth2/end-session` (FR-OIDC-11).
 */
export const Route = createFileRoute("/logout")({
  loader: ({ context, location }) => {
    const search = location.search as Record<string, unknown>
    return {
      ui: context.ui,
      returnTo: safeReturnTo(searchString(search.returnTo), APP_ROUTES.login),
    }
  },
  component: LogoutPage,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const base = runtime.config.base.basePath

        const form = await request.formData().catch(() => new FormData())
        const returnTo = safeReturnTo(
          String(form.get("returnTo") ?? ""),
          APP_ROUTES.login
        )

        // Better Auth clears the cookie; the redirect replays that `Set-Cookie`.
        const result = await callAuth(runtime, "/sign-out", {}, request)

        return redirectWithCookies(
          `${base}${returnTo}${returnTo === APP_ROUTES.login ? "?notice=signed_out" : ""}`,
          result.cookies
        )
      },
    },
  },
})

function LogoutPage() {
  const { ui, returnTo } = Route.useLoaderData()
  const t = getCatalog(ui.locale)

  // There is no `?done=1` variant: the POST redirects to
  // `/login?notice=signed_out`, so the confirmation lives on the page the user
  // actually lands on. A branch here for a parameter nothing emits was one
  // more thing that had to be kept working for no reader.
  return (
    <AuthShell ui={ui} title={t.common.signOut}>
      <form method="post" className="grid gap-4">
        <input type="hidden" name="returnTo" value={returnTo} />
        <Button type="submit" className="w-full">
          {t.common.signOut}
        </Button>
      </form>
    </AuthShell>
  )
}
