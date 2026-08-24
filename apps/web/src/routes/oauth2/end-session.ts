import { createFileRoute } from "@tanstack/react-router"

import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/oauth2/end-session` — RP-initiated logout (FR-OIDC-11).
 *
 * Discovery advertises this endpoint, so it has to exist at the issuer root
 * from the moment discovery does; without it a client that read the document
 * would get a 404 at the one moment it is trying to sign a user out.
 *
 * The provider validates `id_token_hint`, exact-matches
 * `post_logout_redirect_uri` against the client's registered list and echoes
 * `state`. **M9 adds the confirmation page** for the case where no valid hint
 * is supplied — ending a session on an unauthenticated GET is a CSRF surface,
 * so that path has to ask before it acts.
 */
const handle = async ({ request }: { request: Request }) =>
  forwardToAuth(await getRuntime(), request, {
    providerPath: "/oauth2/end-session",
  })

export const Route = createFileRoute("/oauth2/end-session")({
  server: { handlers: { GET: handle, POST: handle } },
})
