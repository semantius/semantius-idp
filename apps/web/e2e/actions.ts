import { randomUUID } from "node:crypto"

import { expect } from "@playwright/test"
import type { Page } from "@playwright/test"

import type { App } from "./fixtures"
import { ADMIN, linkFrom, waitForMail } from "./stack"
import type { Stack } from "./stack"

/**
 * The things every flow spec has to do before it can test anything (TST-6).
 *
 * Written against the **rendered page** rather than the HTTP endpoints
 * underneath: a helper that signs in with `fetch` would keep working the day
 * the sign-in form stops submitting, which is precisely the class of defect
 * this suite exists to catch. Everything here fills fields and presses
 * buttons.
 *
 * Selectors are roles and labels — `getByRole("button", { name: "Sign in" })`
 * — for two reasons. They survive a restyle, and a control that cannot be
 * found by its accessible name is a control a screen reader cannot find
 * either, so the specs fail on the same thing the axe pass would (R-1).
 */

/** A fresh address, so specs sharing one database cannot collide. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`
}

/** Long enough for the default `auth.password.minLength` of 12. */
export const PASSWORD = "e2e-user-password-01"

/**
 * Presses a control that submits a form, and waits for the answer.
 *
 * Every state-changing page here answers with a 303 to somewhere else, so
 * "the URL changed" is the honest signal that the round trip finished. An
 * assertion that raced the navigation would read the *previous* page, which
 * fails in a way that looks like a product bug and is not.
 */
export async function submit(page: Page, name: string | RegExp): Promise<void> {
  const before = page.url()
  await page.getByRole("button", { name, exact: typeof name === "string" }).click()
  await page.waitForURL((url) => url.href !== before)
}

/** Fills the sign-in form and submits it. Says nothing about the outcome. */
export async function signIn(
  page: Page,
  app: App,
  email: string,
  password: string
): Promise<void> {
  await app.goto("/login")
  await page.getByLabel("E-mail address").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await submit(page, "Sign in")
}

/** True while the browser is sitting on the sign-in page. */
export function onLogin(page: Page, app: App): boolean {
  return new URL(page.url()).pathname === `${app.basePath}/login`
}

/** Completes the forced change a temporary password lands on (FR-AUTH-4). */
export async function completeForcedChange(
  page: Page,
  app: App,
  current: string,
  next: string
): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`${app.basePath}/change-password`))
  await page.getByLabel("Current password").fill(current)
  await page.getByLabel("New password", { exact: true }).fill(next)
  await page.getByLabel("Confirm new password").fill(next)
  await submit(page, "Change password")
}

/**
 * Signs in as the bootstrap administrator, doing the forced change if this is
 * the first spec in the run to get here.
 *
 * **Deliberately order-independent.** The bootstrap account starts with
 * `mustChangePassword` (FR-ADMIN-1) and exactly one spec can consume that; a
 * helper that assumed it was the first would make the suite depend on the
 * order Playwright happens to walk the files in. So it tries the settled
 * password, and falls back.
 */
export async function signInAsAdmin(page: Page, app: App): Promise<void> {
  await signIn(page, app, ADMIN.email, ADMIN.password)
  if (onLogin(page, app)) {
    await signIn(page, app, ADMIN.email, ADMIN.bootstrapPassword)
    await completeForcedChange(
      page,
      app,
      ADMIN.bootstrapPassword,
      ADMIN.password
    )
  }
  await expect(page).toHaveURL(app.url("/account"))
}

/** Fills the registration form and submits it (FR-SIGNUP-1). */
export async function register(
  page: Page,
  app: App,
  user: { email: string; password?: string; firstName?: string; lastName?: string }
): Promise<void> {
  await app.goto("/signup")
  if (user.firstName) await page.getByLabel("First name").fill(user.firstName)
  if (user.lastName) await page.getByLabel("Last name").fill(user.lastName)
  await page.getByLabel("E-mail address").fill(user.email)
  await page.getByLabel("Password", { exact: true }).fill(user.password ?? PASSWORD)
  await submit(page, "Create account")
}

/**
 * Opens the link out of a captured message (D30).
 *
 * The link is read from the **text** part and navigated to as the user's own
 * browser would, so what is asserted afterwards is the page an e-mail client
 * would have opened — not an endpoint called directly with a token.
 */
export async function openMailLink(
  page: Page,
  stack: Stack,
  to: string,
  template: string
): Promise<string> {
  const mail = await waitForMail(stack, to, { template })
  const url = linkFrom(mail, stack)
  await page.goto(url)
  return url
}

/** Ends the session through the page a person would use (FR-AUTH-6). */
export async function signOut(page: Page, app: App): Promise<void> {
  await app.goto("/logout")
  await submit(page, "Sign out")
}

/**
 * Registers a user and takes them all the way to being able to sign in.
 *
 * With `auth.requireEmailVerification` on — which every stack has — a fresh
 * account cannot sign in until the link is opened, so almost every spec that
 * needs "a user" needs these three steps rather than one.
 */
export async function createVerifiedUser(
  page: Page,
  app: App,
  stack: Stack,
  prefix: string
): Promise<{ email: string; password: string }> {
  const email = uniqueEmail(prefix)
  await register(page, app, { email, firstName: "Test", lastName: "User" })
  await openMailLink(page, stack, email, "verify-email")
  return { email, password: PASSWORD }
}

/**
 * An {@link App} bound to a page other than the fixture's.
 *
 * The sessions spec needs two browsers signed in as the same person, and the
 * `app` fixture only ever describes the one page Playwright injected.
 */
export function appFor(page: Page, stack: Stack): App {
  const url = (path: string) =>
    path.startsWith("http") ? path : `${stack.baseURL}${path}`
  return { url, goto: (path) => page.goto(url(path)), basePath: stack.basePath }
}
