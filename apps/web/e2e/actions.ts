import { randomUUID } from "node:crypto"

import { expect } from "@playwright/test"
import type { Locator, Page } from "@playwright/test"

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

/** Long enough for the default `auth.password.minLength` of 10 (D53). */
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
  await page
    .getByRole("button", { name, exact: typeof name === "string" })
    .click()
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
 * Signs in as the administrator this run created (FR-ADMIN-1, D52).
 *
 * One password, no fallback. The account is made by the first-run wizard in
 * `globalSetup` before any spec runs, and it carries no forced change — the
 * person who chose the password is the person using it — so the two-attempt
 * dance the old bootstrap account needed is gone with it.
 */
export async function signInAsAdmin(page: Page, app: App): Promise<void> {
  await signIn(page, app, ADMIN.email, ADMIN.password)
  await expect(page).toHaveURL(app.url("/account"))
}

/**
 * Opens the dialog a named control carries, and returns it.
 *
 * The admin actions became triggers rather than inline forms (item 11), and
 * the trigger and the submit inside usually share a name — "Suspend" opens a
 * dialog whose button also says "Suspend". Everything after the click is
 * therefore scoped to the returned dialog, which is the only way those two
 * assertions can be told apart.
 */
/**
 * The modal, and not the toast.
 *
 * Base UI's toast is a `role="dialog"` (`aria-modal="false"`) so a keyboard
 * user can reach its close and action buttons -- which means that from D71,
 * when a success confirmation is a toast, a bare `getByRole("dialog")` matches
 * two things and Playwright's strict mode fails the test rather than the app.
 * The registry component is used verbatim (AGENTS.md), so the selector is what
 * gets more specific: `data-slot="dialog-content"` is what `DialogContent`
 * stamps and the toast does not.
 */
export function modal(page: Page): Locator {
  return page.locator('[data-slot="dialog-content"]')
}

export async function openDialog(
  page: Page,
  name: string,
  /**
   * Where to look for the trigger. `/admin/clients` grew a per-row Edit and a
   * per-row Rotate secret (**D72**), so "the first button called Edit" stopped
   * being a useful answer — it is whichever application happens to sort first.
   * Absent means the page, which is what every caller before this wanted.
   */
  within?: Locator
): Promise<Locator> {
  // Before the click the dialog is not in the DOM at all (Base UI portals on
  // open), so the trigger is the only thing this can match.
  await (within ?? page)
    .getByRole("button", { name, exact: true })
    .first()
    .click()
  const dialog = modal(page)
  await expect(dialog).toBeVisible()
  return dialog
}

/** {@link submit}, scoped to a dialog. */
export async function submitDialog(
  page: Page,
  dialog: Locator,
  name: string
): Promise<void> {
  const before = page.url()
  await dialog.getByRole("button", { name, exact: true }).click()
  await page.waitForURL((url) => url.href !== before)
}

/** Fills the registration form and submits it (FR-SIGNUP-1). */
export async function register(
  page: Page,
  app: App,
  user: {
    email: string
    password?: string
    firstName?: string
    lastName?: string
  }
): Promise<void> {
  await app.goto("/signup")
  if (user.firstName) await page.getByLabel("First name").fill(user.firstName)
  if (user.lastName) await page.getByLabel("Last name").fill(user.lastName)
  await page.getByLabel("E-mail address").fill(user.email)
  await page
    .getByLabel("Password", { exact: true })
    .fill(user.password ?? PASSWORD)
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
