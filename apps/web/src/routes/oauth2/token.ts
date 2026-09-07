import { createFileRoute } from "@tanstack/react-router"

import { rateLimitKeyAddress } from "@/server/http/client-ip"
import { corsFor, preflightResponse, withCors } from "@/server/http/cors"
import { consume, peek, tooManyRequests } from "@/server/http/rate-limit"
import { currentRequest } from "@/server/http/request-log"
import { forwardToAuth } from "@/server/oidc/protocol-proxy"
import { getRuntime } from "@/server/runtime"

/**
 * `{issuer}/oauth2/token`.
 *
 * Browser-based public clients call this directly, so it carries CORS for the
 * origins the deployment registered redirect URIs for — and for nobody else.
 *
 * **The per-client rate limit lives here**, because Better Auth keys
 * every bucket as `ip:path` and offers no way to key on anything else. Per IP
 * alone is the wrong shape for this endpoint: a confidential client behind one
 * NAT is a single address for its whole user base, so the per-IP bucket is
 * either too wide to matter or narrow enough to break the client. Both halves
 * apply — Better Auth's per-IP rule and the two buckets below.
 *
 * **Two buckets, and neither is counted before the provider has answered**
 *. The first version consumed `oauth2_token:<client_id>` on the way
 * in, keyed on a client id read from the request — so anyone who could *name*
 * a client could send six hundred junk requests bearing its id and take that
 * client's token endpoint offline for a minute, indefinitely, without a
 * secret. The client id is unauthenticated input until the provider has
 * checked the credential, and the provider is the only thing that can. So:
 *
 *  - `oauth2_token:<client_id>` counts **successful grants only** — the
 *    provider authenticated the client and honored the grant. That is the
 *    client's own traffic, the only kind that should count against it, and
 *    nobody without the secret can produce it.
 *  - `oauth2_token_attempt:<address>:<client_id>` counts everything else —
 *    a wrong secret, a junk code, a 429 from the per-IP rule — keyed on where
 *    the attempt came from as well as which client it named. Thirty a minute
 *    from one address against one client is a script, not a client.
 *
 * Both are checked with `peek` before forwarding and counted with `consume`
 * afterwards; the race that opens is bounded by the atomic per-IP rule, and
 * it is the price of not counting a request before knowing whose it was.
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
        const limiting =
          runtime.config.file.rateLimit.enabled && clientId !== undefined
        const deps = { database: runtime.database, logger: runtime.logger }
        const address =
          rateLimitKeyAddress(currentRequest()?.clientIp) ?? "unknown"
        const buckets = {
          client: { key: `oauth2_token:${clientId}`, rule: TOKEN_RULE },
          attempt: {
            key: `oauth2_token_attempt:${address}:${clientId}`,
            rule: ATTEMPT_RULE,
          },
        } as const

        if (limiting) {
          for (const [name, bucket] of Object.entries(buckets)) {
            const standing = await peek(deps, bucket.key, bucket.rule)
            if (standing.allowed) continue
            await runtime.audit.record({
              action: "token.issued",
              outcome: "denied",
              actorType: "anonymous",
              target: { type: "client", id: clientId },
              metadata: { reason: "rate_limited", bucket: name },
            })
            return withCors(tooManyRequests(standing.retryAfter), cors)
          }
        }

        const response = await forwardToAuth(runtime, request, {
          providerPath: "/oauth2/token",
        })

        if (limiting) {
          // The provider's answer decides whose request this was. Its own
          // decision is irrelevant here — the response is already the answer;
          // this is what the next `peek` reads.
          const bucket = response.ok ? buckets.client : buckets.attempt
          await consume(deps, bucket.key, bucket.rule)
        }

        return withCors(response, cors)
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
 * Per client, per minute, successful grants. Generous by design: this bucket
 * exists to stop a runaway client, not to shape traffic. A client that
 * legitimately needs more is refreshing far too often and should be told so
 * rather than throttled quietly.
 */
const TOKEN_RULE = { window: 60, max: 600 }

/**
 * Per address and client, per minute, refused requests. This is the
 * credential-guessing bucket: a secret is tried against one client from one
 * place, and thirty wrong answers a minute is no integration's mistake. A
 * legitimate client's successes never land here, so a NAT with a thousand
 * users behind it is not a thousand attempts.
 */
const ATTEMPT_RULE = { window: 60, max: 30 }

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
