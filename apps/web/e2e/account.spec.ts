import {
  appFor,
  createVerifiedUser,
  signIn,
  signOut,
  submit,
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

    await page.getByLabel("Name", { exact: true }).fill("Renamed Person")
    await page.getByLabel("First name").fill("Renamed")
    await page.getByLabel("Last name").fill("Person")
    await submit(page, "Save")

    await expect(page.getByText("Profile updated.")).toBeVisible()
    await page.reload()
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Renamed Person"
    )
  })

  test("the password changes from the security page and comes back to it", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "changepw")
    await signIn(page, app, user.email, user.password)

    await app.goto("/account/security")
    await page.getByRole("link", { name: "Change password" }).click()
    await expect(page).toHaveURL(/change-password/)

    await page.getByLabel("Current password").fill(user.password)
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD)
    await submit(page, "Change password")

    // SEC-3's `returnTo` is a same-origin relative path, and it is honoured.
    await expect(page).toHaveURL(app.url("/account/security"))

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

    await page.getByLabel("What is this key for?").fill("Deploy script")
    await submit(page, "Create key")

    await expect(
      page.getByText("Copy this key now — it will not be shown again.")
    ).toBeVisible()
    const secret = (
      await page.locator("code.font-mono").first().innerText()
    ).trim()
    expect(secret.length, "the key itself").toBeGreaterThan(20)

    await expect(page.getByText("Deploy script")).toBeVisible()

    // FR-MAIL-1: a credential that can act as you is announced.
    const notice = await waitForMail(stack, user.email, {
      template: "api-key-created",
    })
    expect(notice.text).toContain("Deploy script")

    // Reloading the list must not show the secret a second time.
    await app.goto("/account/api-keys")
    expect(await page.content()).not.toContain(secret)

    await submit(page, "Revoke")
    await expect(page.getByText("That key has been revoked.")).toBeVisible()
    await expect(page.getByText("No API keys yet.")).toBeVisible()
  })
})
