/**
 * A minimal relying party, for driving a real OIDC login end to end (TST-4,
 * TST-6, DOC-3).
 *
 * Run it against any deployment of this IdP:
 *
 *     RP_ISSUER=http://127.0.0.1:3000 \
 *     RP_CLIENT_ID=my-app \
 *     RP_CLIENT_SECRET=… \
 *     bun apps/web/e2e/sample-rp.ts
 *
 * then open http://127.0.0.1:4571. It does discovery, an authorization code
 * flow with PKCE, the token exchange, and RP-initiated logout — nothing else.
 * `openid-client` is doing all of the protocol work; what is worth reading
 * here is how little configuration this deployment needs, which is the point
 * DOC-3 makes with it.
 *
 * **`e2e/oidc.spec.ts` drives this exact file**, so the sample cannot rot into
 * something that no longer works: the suite fails if it does.
 *
 * Deliberately not production code. The session store is a `Map` that dies
 * with the process, there is no CSRF protection on `/logout`, and the tokens
 * are printed on the page — all three are what makes it useful to look at, and
 * each is called out below where a real application would differ.
 */

import * as client from "openid-client"

const ISSUER = process.env.RP_ISSUER ?? "http://127.0.0.1:3000"
const CLIENT_ID = process.env.RP_CLIENT_ID ?? "e2e-app"
const CLIENT_SECRET = process.env.RP_CLIENT_SECRET ?? ""
const PORT = Number(process.env.RP_PORT ?? 4571)
const SCOPE = process.env.RP_SCOPE ?? "openid profile email offline_access"
const SELF = `http://127.0.0.1:${PORT}`

/**
 * Everything the RP remembers, keyed by its own session cookie.
 *
 * A real application would put this in a store that survives a restart and
 * would keep the tokens out of the browser's reach; a `Map` is enough to show
 * the flow.
 */
interface RpSession {
  state?: string
  verifier?: string
  claims?: Record<string, unknown>
  /**
   * The profile, from the **userinfo endpoint**.
   *
   * Not from the ID token: `jwt.claimsInIdToken` is false by default, because
   * an ID token is an assertion about *authentication* and profile data
   * belongs at userinfo (FR-OIDC-7). An application that reads `email` off the
   * ID token gets nothing from a default deployment, which is exactly the
   * mistake a sample should not teach.
   */
  userInfo?: Record<string, unknown>
  userInfoError?: string
  accessToken?: string
  idToken?: string
  refreshToken?: string
}

const sessions = new Map<string, RpSession>()

/**
 * `allowInsecureRequests` because the test deployments serve plain HTTP on
 * loopback. Remove it — and everything stops working over http, which is the
 * correct behavior for anything else.
 */
const config = await client.discovery(
  new URL(ISSUER),
  CLIENT_ID,
  CLIENT_SECRET,
  // The IdP registers `web` clients as `client_secret_basic` (FR-OIDC-3);
  // openid-client would otherwise send the secret in the body.
  client.ClientSecretBasic(CLIENT_SECRET),
  { execute: [client.allowInsecureRequests] }
)

function sessionIdFrom(request: Request): string | undefined {
  const cookie = request.headers.get("cookie") ?? ""
  return /(?:^|;\s*)rp_sid=([^;]+)/.exec(cookie)?.[1]
}

function sessionFor(request: Request): { id: string; session: RpSession } {
  const existing = sessionIdFrom(request)
  if (existing && sessions.has(existing)) {
    return { id: existing, session: sessions.get(existing)! }
  }
  const id = crypto.randomUUID()
  const session: RpSession = {}
  sessions.set(id, session)
  return { id, session }
}

function page(body: string, sessionId?: string): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" })
  if (sessionId) {
    headers.set(
      "set-cookie",
      `rp_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax`
    )
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Sample RP</title>` +
      `<body style="font:16px system-ui;margin:2rem;max-width:48rem">${body}</body>`,
    { headers }
  )
}

function redirect(location: string, sessionId?: string): Response {
  const headers = new Headers({ location })
  if (sessionId) {
    headers.set(
      "set-cookie",
      `rp_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax`
    )
  }
  return new Response(null, { status: 303, headers })
}

function escape(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!
  )
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url)
    const { id, session } = sessionFor(request)

    switch (url.pathname) {
      /** So a test can wait for the process rather than for a timer. */
      case "/health":
        return Response.json({ ok: true, issuer: config.serverMetadata().issuer })

      case "/": {
        if (!session.claims) {
          // The cookie is set here as well as on `/login`, so a browser that
          // lands on the front page first keeps the same session through the
          // round trip.
          return page(
            `<h1>Sample RP</h1><p>Not signed in.</p>` +
              `<p><a id="signin" href="/login">Sign in with the IdP</a></p>`,
            id
          )
        }
        return page(
          `<h1>Sample RP</h1><p id="signed-in">Signed in as ` +
            `<b id="sub">${escape(String(session.claims.sub ?? ""))}</b></p>` +
            `<p id="email">${escape(
              String(session.userInfo?.email ?? session.claims.email ?? "")
            )}</p>` +
            `<h2>Profile, from the userinfo endpoint</h2>` +
            `<pre id="userinfo">${escape(
              session.userInfoError ??
                JSON.stringify(session.userInfo ?? {}, null, 2)
            )}</pre>` +
            `<h2>ID token claims</h2>` +
            `<pre id="claims">${escape(JSON.stringify(session.claims, null, 2))}</pre>` +
            `<h2>Access token</h2>` +
            `<pre id="access-token" style="overflow-wrap:anywhere;white-space:pre-wrap">${escape(session.accessToken ?? "")}</pre>` +
            `<p><a id="signout" href="/logout">Sign out everywhere (RP-initiated)</a></p>`
        )
      }

      case "/login": {
        // PKCE on a confidential client too: FR-OIDC-1 defaults it on, and
        // there is no reason to opt out of it.
        session.verifier = client.randomPKCECodeVerifier()
        session.state = client.randomState()
        const authorizationUrl = client.buildAuthorizationUrl(config, {
          redirect_uri: `${SELF}/callback`,
          scope: SCOPE,
          state: session.state,
          code_challenge: await client.calculatePKCECodeChallenge(
            session.verifier
          ),
          code_challenge_method: "S256",
        })
        return redirect(authorizationUrl.href, id)
      }

      case "/callback": {
        if (!session.verifier || !session.state) {
          return page(`<h1>Sample RP</h1><p id="error">No login in progress.</p>`)
        }
        try {
          // No `resource` parameter anywhere in this file — the IdP applies
          // `jwt.audience` as the default (FR-OIDC-6), which is what makes a
          // naïve client's token valid for Neon without it knowing.
          const tokens = await client.authorizationCodeGrant(config, url, {
            pkceCodeVerifier: session.verifier,
            expectedState: session.state,
          })
          session.claims = { ...tokens.claims() }
          session.accessToken = tokens.access_token
          // FR-OIDC-4: the access token is presented to userinfo, and the
          // subject it answers with has to be the one the ID token named —
          // `openid-client` refuses the response otherwise, which is the check
          // a hand-rolled client usually forgets.
          try {
            session.userInfo = await client.fetchUserInfo(
              config,
              tokens.access_token,
              String(tokens.claims()?.sub ?? "")
            )
          } catch (error) {
            session.userInfoError = String(error)
          }
          session.idToken = tokens.id_token
          session.refreshToken = tokens.refresh_token
          session.verifier = undefined
          session.state = undefined
          return redirect("/", id)
        } catch (error) {
          return page(
            `<h1>Sample RP</h1><p id="error">${escape(String(error))}</p>`
          )
        }
      }

      case "/logout": {
        // FR-OIDC-11: the hint is what lets the IdP end the session without
        // asking, and the post-logout URI has to be one the client registered.
        const endSession = client.buildEndSessionUrl(config, {
          post_logout_redirect_uri: `${SELF}/post-logout`,
          ...(session.idToken ? { id_token_hint: session.idToken } : {}),
        })
        sessions.delete(id)
        return redirect(endSession.href)
      }

      case "/post-logout":
        return page(
          `<h1>Sample RP</h1><p id="signed-out">Signed out.</p>` +
            `<p><a href="/login">Sign in again</a></p>`
        )

      default:
        return new Response("Not found", { status: 404 })
    }
  },
})

process.stdout.write(`sample-rp: listening on ${server.url} for ${ISSUER}\n`)
