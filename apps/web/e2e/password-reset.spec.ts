import {
  PASSWORD,
  createVerifiedUser,
  onLogin,
  openMailLink,
  signIn,
  signOut,
  submit,
  uniqueEmail,
} from "./actions"
import { expect, test } from "./fixtures"
import { readMail, waitForMail } from "./stack"

/**
 * Forgotten passwords, through the captured mail (TST-6, FR-AUTH-3, SEC-7).
 *
 * The reset link is opened the way a person opens it — out of the message, in
 * the browser — rather than by posting a token to an endpoint. That is what
 * makes this a test of the *flow* and not of the handler underneath it.
 */

const NEW_PASSWORD = "e2e-reset-password-02"

test.describe("resetting a password", () => {
  test("an unknown address gets the same answer as a known one (SEC-7)", async ({
    page,
    app,
    stack,
  }) => {
    const unknown = uniqueEmail("nobody")

    await app.goto("/forgot-password")
    await page.getByLabel("E-mail address").fill(unknown)
    await submit(page, "Send reset link")

    await expect(
      page.getByText(
        "If there is an account for that address, a reset link is on its way."
      )
    ).toBeVisible()

    // Uniform on screen *and* in what was sent: no message exists for an
    // address with no account, and the page cannot be used to find that out.
    const sent = readMail(stack).filter((mail) => mail.to === unknown)
    expect(sent, "mail sent to an address with no account").toEqual([])
  })

  test("the link sets a new password and retires the old one (FR-AUTH-3)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "reset")

    await app.goto("/forgot-password")
    await page.getByLabel("E-mail address").fill(user.email)
    await submit(page, "Send reset link")
    await expect(
      page.getByText(
        "If there is an account for that address, a reset link is on its way."
      )
    ).toBeVisible()

    await openMailLink(page, stack, user.email, "reset-password")
    await expect(
      page.getByRole("heading", { name: "Choose a new password" })
    ).toBeVisible()
    // The page says what completing this costs before it is completed.
    await expect(
      page.getByText("Signing in again will be needed on your other devices.")
    ).toBeVisible()

    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD)
    await submit(page, "Set new password")

    await expect(page).toHaveURL(/notice=password_changed/)
    await expect(
      page.getByText("Your password has been changed.")
    ).toBeVisible()

    // FR-AUTH-3: the owner is told, whatever they think they did.
    const notice = await waitForMail(stack, user.email, {
      template: "password-changed",
    })
    expect(notice.subject).toContain("password was changed")

    // The old one is gone and the new one works.
    await signIn(page, app, user.email, PASSWORD)
    expect(onLogin(page, app), "the old password still worked").toBe(true)

    await signIn(page, app, user.email, NEW_PASSWORD)
    await expect(page).toHaveURL(app.url("/account"))
    await signOut(page, app)
  })

  test("a reset link works once (FR-AUTH-3)", async ({ page, app, stack }) => {
    const user = await createVerifiedUser(page, app, stack, "reused")

    await app.goto("/forgot-password")
    await page.getByLabel("E-mail address").fill(user.email)
    await submit(page, "Send reset link")

    const link = await openMailLink(page, stack, user.email, "reset-password")
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD)
    await submit(page, "Set new password")
    await expect(page).toHaveURL(/notice=password_changed/)

    // The same URL a second time: the token is spent, and the page says so
    // rather than quietly presenting a form that cannot work.
    await page.goto(link)
    await page.getByLabel("New password", { exact: true }).fill("another-one-01")
    await page.getByLabel("Confirm new password").fill("another-one-01")
    await submit(page, "Set new password")
    await expect(page).toHaveURL(/error=token_/)
  })
})
