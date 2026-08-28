import AxeBuilder from "@axe-core/playwright"

import {
  createVerifiedUser,
  openDialog,
  openMenuDialog,
  openRowMenu,
  signIn,
  signInAsAdmin,
  signOut,
  submit,
  submitDialog,
} from "./actions"
import { expect, test } from "./fixtures"
import type { App } from "./fixtures"
import type { Page } from "@playwright/test"

/**
 * The automated accessibility gate (TST-6, R-1).
 *
 * **Serious and critical only, and zero of them.** axe reports four impact
 * levels; the two below these are largely advisory and a gate that failed on
 * them would be turned off within a month. These two are the ones that stop
 * somebody using the page at all — an unlabelled field, a control with no
 * accessible name, contrast a person cannot read.
 *
 * This is the *automated* half of R-1 and it is not the whole of it: axe
 * cannot tell whether a focus order makes sense or whether an error message
 * says anything useful. The manual half stays in the release checklist. What
 * this catches is the regression nobody would otherwise notice — a field that
 * loses its `<label>` in a refactor.
 */

async function scan(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical"
  )

  // The message is the report: a bare "expected 0, got 2" would send whoever
  // reads it back to the browser to find out which two.
  const described = blocking.map(
    (violation) =>
      `${violation.impact} · ${violation.id}: ${violation.help}\n` +
      violation.nodes
        .map(
          (node) =>
            `    ${node.target.join(" ")}\n      ${node.html}\n` +
            `      ${JSON.stringify(node.any.map((check) => check.data))}`
        )
        .join("\n")
  )
  expect(described, `serious/critical axe violations on ${where}`).toEqual([])
}

/** The pages anyone can reach without a session. */
const PUBLIC_PAGES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/verify-email",
  "/reset-password",
  "/pending-approval",
  "/banned",
  "/logout",
  "/this-route-does-not-exist",
]

const ACCOUNT_PAGES = [
  "/account",
  "/account/security",
  "/account/sessions",
  "/account/api-keys",
  "/account/consents",
]

const ADMIN_PAGES = [
  "/admin",
  // `/admin/users/new` is gone (D64) — creating a user is a dialog on
  // `/admin/users`, and the dialog's contents are scanned with that page once
  // it is open, not as a route of their own.
  "/admin/users",
  "/admin/clients",
  "/admin/roles",
  "/admin/audit",
  "/admin/system",
]

async function scanAll(page: Page, app: App, paths: string[]): Promise<void> {
  for (const path of paths) {
    await app.goto(path)
    await scan(page, path)
  }
}

test.describe("accessibility", () => {
  test("the public pages have no serious or critical violations", async ({
    page,
    app,
  }) => {
    test.slow()
    await scanAll(page, app, PUBLIC_PAGES)
  })

  test("the account area has no serious or critical violations", async ({
    page,
    app,
    stack,
  }) => {
    test.slow()
    const user = await createVerifiedUser(page, app, stack, "a11y")
    await signIn(page, app, user.email, user.password)
    await scanAll(page, app, ACCOUNT_PAGES)

    // **D71**: with a toast on screen. It is a live region rendered into a
    // portal outside the page's landmarks, and its close button's accessible
    // name comes from the registry component rather than from this
    // application's catalog — both of which are exactly the kind of thing axe
    // catches and a reading of the JSX does not. Scanned here rather than as a
    // page of its own, because a toast only exists as a consequence of a save.
    await app.goto("/account")
    await page.getByLabel("First name").fill("Axe")
    await page.getByLabel("Last name").fill("Scanned")
    await submit(page, "Save")
    await expect(page.getByText("Profile updated.")).toBeVisible()
    await scan(page, "/account with a toast showing")

    await signOut(page, app)
  })

  test("the admin area has no serious or critical violations", async ({
    page,
    app,
  }) => {
    test.slow()
    await signInAsAdmin(page, app)
    await scanAll(page, app, ADMIN_PAGES)

    // The detail page is where most of the controls are, so it is worth
    // reaching rather than assuming the list covers it.
    await app.goto("/admin/users?q=e2e-admin@example.com")
    await page.getByRole("link", { name: "e2e-admin@example.com" }).click()
    await scan(page, "/admin/users/:id")

    // **D80**: with a row's actions menu open. Only a database-registered
    // client has one, and the pages above are scanned before any spec creates
    // one — so the row is made here and removed again. Worth the six lines
    // for the same reason D71 scanned the toast: it is a portalled widget
    // outside the page's landmarks, and its trigger's accessible name is this
    // application's rather than the registry's.
    await app.goto("/admin/clients")
    const form = await openDialog(page, "Add an application")
    await form.getByLabel("Name").fill("Axe Scanned")
    await form.getByLabel("Client ID").fill("a11y-client")
    await form
      .getByLabel("Redirect URIs", { exact: true })
      .fill("https://example.test/callback")
    await submitDialog(page, form, "Add an application")

    const row = page.locator("tbody tr").filter({ hasText: "a11y-client" })
    const menu = await openRowMenu(page, row, "Axe Scanned")
    await scan(page, "/admin/clients with a row menu open")

    const confirm = await openMenuDialog(page, menu, "Remove")
    await submitDialog(page, confirm, "Remove")

    // **D82**: with the sidebar's user menu open, and then with the sidebar
    // collapsed to its icon rail. The menu is here for the same reason as the
    // toast and the row menu above — a portalled popup outside the page's
    // landmarks. The rail is here because collapsing it changes what every
    // control on the left is: an 8×8 square whose label is clipped rather
    // than removed, which is the arrangement that would silently lose a
    // link's accessible name if the markup ever changed.
    await page.getByRole("button", { name: /e2e-admin@example\.com/ }).click()
    await scan(page, "/admin/clients with the user menu open")
    await page.keyboard.press("Escape")

    await page.locator('[data-sidebar="trigger"]').click()
    await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
      "data-state",
      "collapsed"
    )
    await scan(page, "/admin/clients with the sidebar collapsed")
    await page.locator('[data-sidebar="trigger"]').click()

    await signOut(page, app)
  })
})
