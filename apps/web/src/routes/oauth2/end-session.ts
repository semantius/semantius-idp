import { createFileRoute } from "@tanstack/react-router"

import { redirectWithCookies } from "@/server/http/auth-proxy"
import { APP_ROUTES } from "@/server/oidc/base-path"
import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/oauth2/end-session` — RP-initiated logout (FR-OIDC-11).
 *
 * The provider validates `id_token_hint`, exact-matches
 * `post_logout_redirect_uri` against the client's registered list and echoes
 * `state`. With a hint that names the current session it ends it and redirects
 * straight back to the client; anything less — no hint, an expired one, a hint
 * for a different session — and it asks first, because a GET that ends a
 * session is a CSRF surface: any page could sign a user out with an `<img>`
 * tag, and "sign out" is a denial of service against them, not a favour.
 *
 * **When it asks, the question has to be ours.** The provider's own
 * confirmation is unbranded, unstyled HTML served straight from the library
 * (`<h1>Confirm logout</h1>`), and FR-OIDC-11's confirmation page is
 * `/sign-out` — this deployment's wording, on this deployment's pages. So an
 * HTML answer is turned into a redirect to that page, carrying the request
 * untouched **and the provider's `Set-Cookie` with it**: that cookie is the
 * signed, short-lived confirmation state, and the POST from `/sign-out` is
 * refused without it.
 *
 * Everything else the provider answers — the redirect back to the client, a
 * protocol error — is passed through, because it is the protocol's to decide.
 *
 * This route deliberately does **not** try to second-guess the hint. An
 * earlier version skipped the provider entirely when no `id_token_hint` was
 * present and sent the browser to `/sign-out` on its own, which meant no
 * confirmation cookie was ever minted and the POST that followed could only
 * fail. Nothing noticed, because until M13 nothing had ever driven an
 * RP-initiated logout.
 */
const handle = async ({ request }: { request: Request }) => {
  const runtime = await getRuntime()
  const url = new URL(request.url)

  const answer = await forwardToAuth(runtime, request, {
    providerPath: "/oauth2/end-session",
  })

  if (request.method === "GET" && isHtml(answer)) {
    const query = new URLSearchParams(url.search)
    return redirectWithCookies(
      `${runtime.config.base.basePath}${APP_ROUTES.endSessionConfirm}${
        query.size ? `?${query.toString()}` : ""
      }`,
      answer.headers.getSetCookie()
    )
  }

  return answer
}

function isHtml(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/html")
}

export const Route = createFileRoute("/oauth2/end-session")({
  server: { handlers: { GET: handle, POST: handle } },
})
