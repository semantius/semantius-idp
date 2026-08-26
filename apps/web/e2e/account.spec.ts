import {
  appFor,
  createVerifiedUser,
  openDialog,
  signIn,
  signOut,
  submit,
  submitDialog,
} from "./actions"
import { expect, test } from "./fixtures"
import { waitForMail } from "./stack"

/**
 * The signed-in area (TST-6, FR-ACCT-1, FR-KEY-1).
 *
 * Each test creates the person it needs. Sharing one account across the file
 * would be faster and would also mean that changing a password in one test
 * decided whether another passed — which is how a suite acquires an order it
 * never chose.
 */

const NEW_PASSWORD = "e2e-account-password-02"

test.describe("the account area", () => {
  test("the profile saves, and the address is shown as confirmed", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "profile")
    await signIn(page, app, user.email, user.password)

    await expect(page.getByText(user.email)).toBeVisible()
    await expect(page.getByText("Confirmed")).toBeVisible()

    // D49: the two parts are the inputs; the display name is derived from
    // them and shown read-only, so there is nothing here to type it into.
    await page.getByLabel("First name").fill("Renamed")
    await page.getByLabel("Last name").fill("Person")
    await submit(page, "Save")

    await expect(page.getByText("Profile updated.")).toBeVisible()
    await page.reload()
    await expect(page.getByLabel("First name")).toHaveValue("Renamed")
    await expect(page.getByText("Renamed Person")).toBeVisible()
  })

  test("the password changes from the security page and stays on it", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "changepw")
    await signIn(page, app, user.email, user.password)

    await app.goto("/account/security")
    // A dialog since D62/F5, like every other action on this page. The
    // standalone `/change-password` page stays — it is the forced-change page
    // (FR-AUTH-4) and what `/.well-known/change-password` redirects to.
    const form = await openDialog(page, "Change password")
    await form.getByLabel("Current password").fill(user.password)
    await form.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD)
    await form.getByLabel("Confirm new password").fill(NEW_PASSWORD)
    await submitDialog(page, form, "Change password")

    await expect(page).toHaveURL(/\/account\/security/)
    await expect(page.getByText("Your password has been changed.")).toBeVisible()

    const notice = await waitForMail(stack, user.email, {
      template: "password-changed",
    })
    expect(notice.subject).toContain("password was changed")

    await signOut(page, app)
    await signIn(page, app, user.email, NEW_PASSWORD)
    await expect(page).toHaveURL(app.url("/account"))
  })

  test("a second browser shows up in the session list and can be signed out (FR-ACCT-1)", async ({
    page,
    app,
    stack,
    browser,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "sessions")
    await signIn(page, app, user.email, user.password)

    const other = await browser.newContext()
    const otherPage = await other.newPage()
    await signIn(otherPage, appFor(otherPage, stack), user.email, user.password)
    await expect(otherPage).toHaveURL(app.url("/account"))

    await app.goto("/account/sessions")
    await expect(page.getByText("This device")).toBeVisible()
    // Two sessions, and exactly one of them is this browser.
    const rows = page.locator("main li")
    await expect(rows).toHaveCount(2)

    await submit(page, "Sign out everywhere else")
    await expect(page.getByText("That session has been signed out.")).toBeVisible()
    await expect(page.locator("main li")).toHaveCount(1)

    // The other browser really is out, not merely absent from a list.
    await otherPage.goto(app.url("/account"))
    await expect(otherPage).toHaveURL(new RegExp(`${app.basePath}/login`))
    await other.close()
  })

  test("an API key is shown once, listed, and revoked (FR-KEY-1)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "apikeys")
    await signIn(page, app, user.email, user.password)

    await app.goto("/account/api-keys")
    await expect(page.getByText("No API keys yet.")).toBeVisible()

    const form = await openDialog(page, "Create key")
    await form.getByLabel("What is this key for?").fill("Deploy script")
    await submitDialog(page, form, "Create key")

    // Shown once, in a dialog, and **not** in the URL: the POST stashes the key
    // server-side and the redirect carries an opaque handle (one-shot.ts).
    const shown = page.getByRole("dialog")
    await expect(
      shown.getByText("Copy this key now — it will not be shown again.")
    ).toBeVisible()
    const secret = (
      await shown.locator('[data-slot="one-shot-value"]').innerText()
    ).trim()
    expect(secret.length, "the key itself").toBeGreaterThan(20)
    expect(page.url(), "the key is not in the URL").not.toContain(secret)

    await page.keyboard.press("Escape")
    await expect(page.getByText("Deploy script")).toBeVisible()

    // FR-MAIL-1: a credential that can act as you is announced.
    const notice = await waitForMail(stack, user.email, {
      template: "api-key-created",
    })
    expect(notice.text).toContain("Deploy script")

    // Reloading the list must not show the secret a second time — claiming the
    // stash consumed it, which is what makes "shown once" true.
    await app.goto("/account/api-keys")
    expect(await page.content()).not.toContain(secret)

    await submit(page, "Revoke")
    await expect(page.getByText("That key has been revoked.")).toBeVisible()
    await expect(page.getByText("No API keys yet.")).toBeVisible()
  })
})
