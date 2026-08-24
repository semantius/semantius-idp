import { createFileRoute } from "@tanstack/react-router"
import { eq } from "drizzle-orm"

import { redirectWithCookies } from "@/server/http/auth-proxy"
import { readSession } from "@/server/http/session"
import { gateResumes, gateRoute, nextGate } from "@/server/oidc/gate-chain"
import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"
import type { Runtime } from "@/server/runtime"

/**
 * `{issuer}/oauth2/authorize` (FR-OIDC-4, FR-OIDC-9).
 *
 * The gate chain runs **before** the request reaches the provider, because the
 * provider's own check is "is there a session" and nothing more. With
 * `skipConsent` on, a live session belonging to a suspended user — or to one
 * who has never completed a forced password change — would be handed an
 * authorization code. A session outlives the state that should have ended it,
 * and this is where that is caught (FR-AUTH-4, FR-SIGNUP-2).
 *
 * A gated request comes back to *this URL*, query and all, so the flow
 * restarts with every precondition satisfied rather than being reconstructed
 * from a half-remembered state.
 *
 * No CORS headers: an authorization request is a navigation, not a fetch, and
 * a page that could read the response would be reading an authorization code.
 */
const handle = async ({ request }: { request: Request }) => {
  const runtime = await getRuntime()
  const base = runtime.config.base.basePath

  const session = await readSession(runtime, request)
  const gate = nextGate({
    user: session?.user ? await gateUser(runtime, session.user.id) : null,
  })

  // `signin` is the provider's own job: it redirects to `loginPage` with the
  // signed request, which is what makes the continuation work at all.
  if (gate && gate.kind !== "signin") {
    const here = new URL(request.url)
    const returnTo = `/oauth2/authorize${here.search}`
    const target = `${base}${gateRoute(gate)}`
    return redirectWithCookies(
      gateResumes(gate)
        ? `${target}?returnTo=${encodeURIComponent(returnTo)}${gate.kind === "change-password" ? "&forced=1" : ""}`
        : target
    )
  }

  return forwardToAuth(runtime, request, { providerPath: "/oauth2/authorize" })
}

/**
 * The user's *current* state, read past the cookie cache.
 *
 * The cached copy is up to five minutes old, and five minutes is exactly the
 * window in which a ban has to start biting.
 */
async function gateUser(runtime: Runtime, userId: string) {
  const { user } = runtime.database.schema
  const [row] = await runtime.database.db
    .select({
      status: user.status,
      banned: user.banned,
      banExpires: user.banExpires,
      mustChangePassword: user.mustChangePassword,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  return row ?? null
}

export const Route = createFileRoute("/oauth2/authorize")({
  server: { handlers: { GET: handle, POST: handle } },
})
