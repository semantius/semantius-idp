import { createRemoteJWKSet, jwtVerify } from "jose"

import { createVerifiedUser, signIn, signOut, submit } from "./actions"
import { expect, test } from "./fixtures"
import { startRelyingParty } from "./rp"
import { CLIENT, CONSENT_CLIENT } from "./stack"

/**
 * A complete OIDC login, driven through the sample relying party (TST-4,
 * TST-6, FR-OIDC-1/5/6/9/10/11).
 *
 * The integration suite already proves the protocol against `auth.handler`.
 * What only this can prove is that a **third-party client library**, pointed
 * at a **running container** by nothing but an issuer URL, gets all the way to
 * a verified token — including under a sub-path, where discovery, the
 * authorization redirect, the cookie `Path` and the callback all have to agree
 * (OPS-10, risk R3).
 */

test.describe.configure({ mode: "serial" })

test.describe("a relying party signs a user in", () => {
  test("discovery names this deployment as the issuer (FR-OIDC-15)", async ({
    page,
    app,
    stack,
  }) => {
    const discovery = await page.request.get(
      app.url("/.well-known/openid-configuration")
    )
    expect(discovery.ok()).toBe(true)
    const metadata = (await discovery.json()) as Record<string, string>

    // Byte-for-byte, because a client library compares it against what it was
    // configured with and refuses the tokens if it differs.
    expect(metadata.issuer).toBe(stack.baseURL)
    expect(metadata.authorization_endpoint).toBe(
      `${stack.baseURL}/oauth2/authorize`
    )
    // D45: the advertised key set is the well-known one, because that is the
    // single prefix a deployment has to publish for Neon to reach it.
    expect(metadata.jwks_uri).toBe(`${stack.baseURL}/.well-known/jwks.json`)

    // …and the other path answers with the same body, which is the whole of
    // what FR-OIDC-15 promises about it.
    const advertised = await page.request.get(metadata.jwks_uri!)
    const alternate = await page.request.get(`${stack.baseURL}/api/auth/jwks`)
    expect(await advertised.json()).toEqual(await alternate.json())

    if (stack.basePath !== "") {
      // OPS-10 / FR-OIDC-15: under a sub-path the RFC 8414 document also lives
      // at the origin root, which is the route the shipped Caddyfile adds and
      // the only place a strict RFC 8414 client will look.
      const origin = new URL(stack.baseURL).origin
      const atRoot = await page.request.get(
        `${origin}/.well-known/oauth-authorization-server${stack.basePath}`
      )
      expect(atRoot.ok(), "the origin-root RFC 8414 route").toBe(true)
      expect(((await atRoot.json()) as { issuer: string }).issuer).toBe(
        stack.baseURL
      )
    }
  })

  test("code + PKCE, no `resource` parameter, and the token verifies (FR-OIDC-5/6)", async ({
    page,
    app,
    stack,
  }) => {
    test.slow()
    const user = await createVerifiedUser(page, app, stack, "rp")
    const rp = await startRelyingParty(stack, CLIENT)

    // SEC-4 and FR-OIDC-1 have to hold at the same time, and for one release
    // they did not: `form-action 'self'` canceled the 303 that carries the
    // authorization code to the client, because Chromium applies the directive
    // to the redirect a submission follows. The browser sat on a filled-in
    // sign-in form and the only trace was a console refusal nothing read.
    const refusals: string[] = []
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) {
        refusals.push(message.text())
      }
    })

    try {
      await page.goto(rp.url)
      await page.getByRole("link", { name: "Sign in with the IdP" }).click()

      // The IdP asked for a sign-in, carrying the authorization request with
      // it (FR-OIDC-9) — either as the provider's own signed query, or as a
      // `returnTo` back to `/oauth2/authorize`. With neither, the sign-in has
      // nowhere to resume to and lands on `auth.defaultRedirect`, which looks
      // like a broken client and is not.
      await expect(page).toHaveURL(new RegExp(`${app.basePath}/login`))
      expect(
        page.url(),
        "the sign-in page was reached with the authorization"
      ).toMatch(/[?&](sig|returnTo)=/)
      await page.getByLabel("E-mail address").fill(user.email)
      await page.getByLabel("Password", { exact: true }).fill(user.password)
      await submit(page, "Sign in")

      // `skipConsent` is the default for a file-configured client, so the
      // browser goes straight back to the application (FR-OIDC-10) — the
      // authorization resumed rather than dropping the user on `/account`
      // (FR-OIDC-9).
      expect(refusals, "the policy refused something on the way").toEqual([])
      expect(page.url(), "where the sign-in landed").toContain(rp.url)
      await expect(page.locator("#signed-in")).toBeVisible()
      // FR-OIDC-4, FR-OIDC-7: the address comes from **userinfo**, not from
      // the ID token — `jwt.claimsInIdToken` is false by default, because an
      // ID token is an assertion about authentication and profile data
      // belongs at userinfo. So this asserts the whole of that round trip:
      // the access token was accepted there, and the subject matched.
      await expect(page.locator("#email")).toHaveText(user.email)

      const accessToken = (await page.locator("#access-token").innerText()).trim()
      expect(accessToken.split(".")).toHaveLength(3)

      // FR-OIDC-5/6: a plain code+PKCE login with no `resource` parameter
      // still yields a JWT whose audience includes `jwt.audience` (D32), and
      // it verifies against the published JWKS with ES256.
      const jwks = createRemoteJWKSet(new URL(`${stack.baseURL}/api/auth/jwks`))
      const { payload, protectedHeader } = await jwtVerify(accessToken, jwks, {
        issuer: stack.baseURL,
        audience: stack.baseURL,
      })
      expect(protectedHeader.alg).toBe("ES256")
      expect(protectedHeader.kid, "Neon requires a `kid`").toBeTruthy()
      expect(payload.client_id).toBe(CLIENT.clientId)
      expect(payload.azp).toBe(CLIENT.clientId)
      expect(payload.email).toBe(user.email)
      expect(payload.scope).toContain("openid")
      expect(Array.isArray(payload.roles)).toBe(true)

      // FR-OIDC-11: the client asks for a logout with the token it holds.
      //
      // **The confirmation is expected here**, and it is this deployment's own
      // page rather than the provider's unbranded one. Whether the provider
      // asks at all depends on it being able to verify the `id_token_hint`,
      // which means fetching its own JWKS from `server.baseUrl` — and in this
      // harness that address is a host-side loopback port the container cannot
      // reach (D47). A real deployment resolves its own issuer and goes
      // straight through; both paths end here, so this asserts the branded
      // page when it appears and the completed logout either way.
      await page.getByRole("link", { name: /Sign out everywhere/ }).click()

      if (await page.getByRole("button", { name: "Sign out" }).isVisible()) {
        await expect(
          page.getByRole("heading", { name: "Sign out?" }),
          "the confirmation is this deployment's page, not the provider's"
        ).toBeVisible()
        await submit(page, "Sign out")
      }

      await expect(page.locator("#signed-out")).toBeVisible()

      await app.goto("/account")
      await expect(page).toHaveURL(new RegExp(`${app.basePath}/login`))
    } finally {
      await rp.stop()
    }
  })

  test("a client that does not skip consent asks, and Deny means no (FR-OIDC-10)", async ({
    page,
    app,
    stack,
  }) => {
    test.slow()
    const user = await createVerifiedUser(page, app, stack, "consent")
    const rp = await startRelyingParty(stack, CONSENT_CLIENT)

    try {
      await signIn(page, app, user.email, user.password)

      await page.goto(rp.url)
      await page.getByRole("link", { name: "Sign in with the IdP" }).click()

      // Already signed in, so the first interstitial is the consent page.
      await expect(
        page.getByRole("heading", { name: /wants to access your account/ })
      ).toBeVisible()
      await expect(page.getByText("See your e-mail address")).toBeVisible()

      await submit(page, "Deny")
      // The provider returns the refusal to the client, which is where a
      // denied consent belongs — not on an IdP error page.
      await page.waitForURL(/\/callback\?/)
      await expect(page.locator("#error")).toBeVisible()

      // And again, allowing this time.
      await page.goto(rp.url)
      await page.getByRole("link", { name: "Sign in with the IdP" }).click()
      await submit(page, "Allow")
      await expect(page.locator("#signed-in")).toBeVisible()

      // FR-OIDC-10: the grant is remembered, so a second authorization does
      // not ask again.
      await page.goto(`${rp.url}/login`)
      await expect(page.locator("#signed-in")).toBeVisible()

      // …and the user can take it back (FR-OIDC-10, FR-OIDC-12).
      await app.goto("/account/consents")
      await expect(page.getByText("E2E Consent App")).toBeVisible()
      await submit(page, "Disconnect")
      await expect(
        page.getByText("That application has been disconnected.")
      ).toBeVisible()

      await page.goto(`${rp.url}/login`)
      await expect(
        page.getByRole("heading", { name: /wants to access your account/ })
      ).toBeVisible()
    } finally {
      await rp.stop()
      await signOut(page, app)
    }
  })
})
