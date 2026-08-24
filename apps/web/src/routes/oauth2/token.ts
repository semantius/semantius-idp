import { createFileRoute } from "@tanstack/react-router"

import { corsFor, preflightResponse, withCors } from "@/server/http/cors"
import { consume, tooManyRequests } from "@/server/http/rate-limit"
import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/oauth2/token` (FR-OIDC-4, FR-OIDC-17).
 *
 * Browser-based public clients call this directly, so it carries CORS for the
 * origins the deployment registered redirect URIs for — and for nobody else.
 *
 * **The per-client rate limit lives here** (SEC-2), because Better Auth keys
 * every bucket as `ip:path` and offers no way to key on anything else. Per IP
 * alone is the wrong shape for this endpoint: a confidential client behind one
 * NAT is a single address for its whole user base, so the per-IP bucket is
 * either too wide to matter or narrow enough to break the client. Both halves
 * apply — Better Auth's per-IP rule and this per-client one.
 */
export const Route = createFileRoute("/oauth2/token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runtime = await getRuntime()
        const cors = corsFor(request, runtime.config, "clients")

        // The body is read here and replayed below: a `Request` body can only
        // be consumed once, and the client id is in it for every grant type
        // except the ones that put it in `Authorization`.
        const body = await request.clone().text()
        const clientId = clientIdFrom(request, body)

        if (runtime.config.file.rateLimit.enabled && clientId) {
          const decision = await consume(
            { database: runtime.database, logger: runtime.logger },
            `oauth2_token:${clientId}`,
            TOKEN_RULE
          )
          if (!decision.allowed) {
            await runtime.audit.record({
              action: "token.issued",
              outcome: "denied",
              actorType: "anonymous",
              target: { type: "client", id: clientId },
              metadata: { reason: "rate_limited" },
            })
            return withCors(tooManyRequests(decision.retryAfter), cors)
          }
        }

        return withCors(
          await forwardToAuth(runtime, request, {
            providerPath: "/oauth2/token",
          }),
          cors
        )
      },

      /**
       * A protocol endpoint that only takes POST answers 405, not the app's
       * HTML. Without this the router falls through to the page tree and a
       * client doing a GET gets a 200 with a sign-in page in it.
       */
      GET: () =>
        new Response(null, {
          status: 405,
          headers: { allow: "POST, OPTIONS", "cache-control": "no-store" },
        }),
      OPTIONS: async ({ request }) => {
        const runtime = await getRuntime()
        return preflightResponse(corsFor(request, runtime.config, "clients"))
      },
    },
  },
})

/**
 * Per client, per minute. Generous by design: this bucket exists to stop a
 * runaway or a credential-stuffing script, not to shape traffic. A client that
 * legitimately needs more is refreshing far too often and should be told so
 * rather than throttled quietly.
 */
const TOKEN_RULE = { window: 60, max: 600 }

/**
 * The client id, from wherever this grant put it.
 *
 * `client_secret_basic` puts it in `Authorization`, everything else puts it in
 * the form body. Reading only one of the two would leave whichever half of the
 * deployment's clients uses the other completely unlimited — and the
 * confidential clients, which use Basic, are the ones with a secret worth
 * guessing at.
 *
 * A request with no identifiable client is not refused here: it is malformed
 * or unauthenticated, and the provider's own answer to that is better than a
 * 429.
 */
function clientIdFrom(request: Request, body: string): string | undefined {
  const authorization = request.headers.get("authorization")
  if (authorization?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(authorization.slice(6).trim())
      const separator = decoded.indexOf(":")
      const id = separator === -1 ? decoded : decoded.slice(0, separator)
      // RFC 6749 §2.3.1 form-encodes both halves before base64.
      if (id !== "") return decodeURIComponent(id)
    } catch {
      // Undecodable credentials are the provider's 401 to give, not ours.
    }
  }
  const id = new URLSearchParams(body).get("client_id")
  return id === null || id === "" ? undefined : id
}
