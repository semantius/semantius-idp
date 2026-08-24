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
 * `state`.
 *
 * **Without a valid `id_token_hint` this asks first.** A GET that ends a
 * session is a CSRF surface: any page could sign a user out with an `<img>`
 * tag, and "sign out" is a denial-of-service against them, not a favour. With
 * a hint, the request is proof that a client the user was actually signed in
 * to is asking, so it proceeds; without one, the browser goes to the
 * confirmation page, which asks and then POSTs.
 */
const handle = async ({ request }: { request: Request }) => {
  const runtime = await getRuntime()
  const url = new URL(request.url)

  if (request.method === "GET" && !url.searchParams.get("id_token_hint")) {
    const query = new URLSearchParams(url.search)
    return redirectWithCookies(
      `${runtime.config.base.basePath}${APP_ROUTES.endSessionConfirm}${
        query.size ? `?${query.toString()}` : ""
      }`
    )
  }

  return forwardToAuth(runtime, request, {
    providerPath: "/oauth2/end-session",
  })
}

export const Route = createFileRoute("/oauth2/end-session")({
  server: { handlers: { GET: handle, POST: handle } },
})
