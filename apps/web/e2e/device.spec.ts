import AxeBuilder from "@axe-core/playwright"
import type { APIRequestContext, Page } from "@playwright/test"
import { decodeJwt } from "jose"

import {
  createVerifiedUser,
  onLogin,
  signIn,
  signInAsAdmin,
  submit,
} from "./actions"
import { expect, test } from "./fixtures"
import type { App } from "./fixtures"
import { DEVICE_CLIENT } from "./stack"
import type { Stack } from "./stack"

/**
 * The device grant, the way `semantius login` on a headless box meets it:
 * a code from the issuer-root endpoint, a person approving it at `/device`
 * in a browser, and the CLI's poll collecting the tokens — against the built
 * image, in both deployment shapes.
 *
 * The shape matters here more than for most pages. The plugin's own default
 * verification URI is origin-relative and pointed at the host root under a
 * sub-path, and discovery's rewrite puts the device endpoint at the issuer
 * root, where only a route of ours answers. Neither is visible to a test
 * that calls the provider directly.
 */

test.describe.configure({ mode: "serial" })

const DEVICE = "urn:ietf:params:oauth:grant-type:device_code"

let user: { email: string; password: string } | undefined

// The CLI's calls go through Playwright's own `request` fixture, never the
// page's: that one carries the browser's session cookie, and a cookie-bearing
// post with no `Origin` is refused before anything else looks at it. A CLI
// has no cookie — the test has to not have one either.

interface CodeAnswer {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
}

/** What the CLI sends first, at the address discovery advertises. */
async function requestCode(
  request: APIRequestContext,
  stack: Stack
): Promise<CodeAnswer> {
  const discovery = (await (
    await request.get(`${stack.baseURL}/.well-known/openid-configuration`)
  ).json()) as { device_authorization_endpoint: string }
  expect(discovery.device_authorization_endpoint).toBe(
    `${stack.baseURL}/device/code`
  )

  const response = await request.post(discovery.device_authorization_endpoint, {
    form: {
      client_id: DEVICE_CLIENT.clientId,
      scope: "openid profile email offline_access",
    },
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as CodeAnswer
}

async function poll(
  request: APIRequestContext,
  stack: Stack,
  deviceCode: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await request.post(`${stack.baseURL}/oauth2/token`, {
    form: {
      grant_type: DEVICE,
      device_code: deviceCode,
      client_id: DEVICE_CLIENT.clientId,
    },
  })
  return {
    status: response.status(),
    body: (await response.json()) as Record<string, unknown>,
  }
}

/**
 * Follows the link the CLI printed, signing in on the way if the browser is
 * not. `signIn()` would start from a bare `/login` and lose the code; this
 * fills the page the link was redirected to, which carries it.
 */
async function openVerificationLink(
  page: Page,
  app: App,
  link: string
): Promise<void> {
  await page.goto(link)
  if (onLogin(page, app)) {
    await page.getByLabel("E-mail address").fill(user!.email)
    await page.getByLabel("Password", { exact: true }).fill(user!.password)
    await submit(page, "Sign in")
  }
  await expect(page).toHaveURL(/\/device\?user_code=/)
}

test("a CLI signs a person in through /device", async ({
  page,
  app,
  stack,
  request,
}) => {
  test.slow()
  user = await createVerifiedUser(page, app, stack, "device")
  const code = await requestCode(request, stack)

  // Inside the mount under a sub-path, which the plugin's default was not.
  expect(code.verification_uri).toBe(`${stack.baseURL}/device`)
  expect(code.verification_uri_complete).toBe(
    `${stack.baseURL}/device?user_code=${code.user_code}`
  )

  await openVerificationLink(page, app, code.verification_uri_complete)

  // The client is `skipConsent: true` and the screen is here anyway: it is
  // the one place a code somebody else started can be noticed.
  await expect(
    page.getByRole("heading", { name: "Allow E2E CLI to sign in as you?" })
  ).toBeVisible()
  await expect(page.getByText(user.email)).toBeVisible()
  await expect(
    page.getByText(/Only continue if you started this sign-in yourself/)
  ).toBeVisible()
  await expect(page.getByText(`Code: ${code.user_code}`)).toBeVisible()

  const results = await new AxeBuilder({ page }).analyze()
  expect(
    results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.help}`),
    "serious/critical axe violations on the approval screen"
  ).toEqual([])

  await submit(page, "Allow")
  await expect(
    page.getByRole("heading", { name: "You are signed in" })
  ).toBeVisible()

  const tokens = await poll(request, stack, code.device_code)
  expect(tokens.status, JSON.stringify(tokens.body)).toBe(200)
  expect(tokens.body.refresh_token, "a device sign-in outlives one token").toBeTruthy()
  expect(decodeJwt(String(tokens.body.access_token)).iss).toBe(stack.baseURL)
})

test("a denied code gives the CLI nothing", async ({
  page,
  app,
  stack,
  request,
}) => {
  await signIn(page, app, user!.email, user!.password)
  const code = await requestCode(request, stack)
  await openVerificationLink(page, app, code.verification_uri_complete)

  await submit(page, "Deny")
  await expect(page.getByRole("heading", { name: "Sign-in denied" })).toBeVisible()
  expect((await poll(request, stack, code.device_code)).body.error).toBe(
    "access_denied"
  )
})

test("a mistyped code is refused on the entry form, with the reason", async ({
  page,
  app,
}) => {
  await signIn(page, app, user!.email, user!.password)
  await app.goto("/device")
  await page.getByLabel("Code").fill("WRONG-CODE")
  await submit(page, "Continue")
  await expect(page.getByText(/That code is not valid/)).toBeVisible()
  // Kept, so the person can correct it rather than retype it.
  await expect(page.getByLabel("Code")).toHaveValue("WRONG-CODE")
})

test("an administrator gives a native application the grant, and only a native one", async ({
  page,
  app,
}) => {
  await signInAsAdmin(page, app)
  await app.goto("/admin/clients/new")
  await page.getByLabel("Name").fill("Device Tool")
  await page.getByLabel("Client ID").fill("e2e-device-tool")
  await page
    .getByLabel("Redirect URIs", { exact: true })
    .fill("http://127.0.0.1:53690/callback")
  const box = page.getByRole("checkbox", {
    name: "Allow sign-in from devices without a browser",
  })
  await box.click()

  // The form's default type is a single-page app, which the grant is not for:
  // refused under the box, before any round trip.
  await page.getByRole("button", { name: "Add an application" }).click()
  await expect(
    page.getByText(/Only a desktop or mobile application can sign in/)
  ).toBeVisible()

  await page.getByLabel("Type").selectOption("native")
  await submit(page, "Add an application")
  await expect(page).toHaveURL(/\/admin\/clients\?notice=/)

  await app.goto("/admin/clients/e2e-device-tool/edit")
  await expect(box).toBeChecked()
})
