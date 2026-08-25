import { createVerifiedUser, signIn, signOut, submit } from "./actions"
import { expect, test } from "./fixtures"
import { waitForMail } from "./stack"
import { totpCode } from "../src/tests/fixtures/totp"

/**
 * Enrolling in and answering a second factor (TST-6, FR-2FA-1/2).
 *
 * Codes come from `src/tests/fixtures/totp.ts` — an RFC 6238 implementation
 * written for the integration suite precisely so a test does not generate its
 * codes with the same helper the server verifies them with. Reusing it here
 * keeps that property and costs nothing.
 *
 * The secret is read off the enrolment page's **manual-entry key** rather than
 * decoded from the QR image: the QR is rendered server-side as an SVG and is
 * `aria-hidden`, and the text beside it is what a person without a camera
 * uses — so reading it is also a check that it is there.
 */

test.describe.configure({ mode: "serial" })

/**
 * What the enrolment produced, for the test after it.
 *
 * A module-level variable rather than a fixture: enrolling twice would be two
 * minutes spent proving the same thing, and `mode: "serial"` with one worker
 * is exactly the arrangement where this is safe.
 */
let enrolled:
  | { email: string; password: string; secret: string; backupCodes: string[] }
  | undefined

test.describe("two-factor authentication", () => {
  test("enrol, then answer the challenge on the next sign-in", async ({
    page,
    app,
    stack,
  }) => {
    test.slow()
    const user = await createVerifiedUser(page, app, stack, "twofactor")
    await signIn(page, app, user.email, user.password)

    await app.goto("/account/security")
    await expect(
      page.getByText("Two-factor authentication is off.")
    ).toBeVisible()

    // Turning it on asks for the password again (FR-AUTH-5); the enrolment
    // only appears once it is right.
    await page.getByLabel("Password", { exact: true }).fill(user.password)
    await submit(page, "Turn on")

    await expect(
      page.getByText(
        "Scan this with your authenticator app, then enter the code it shows."
      )
    ).toBeVisible()

    const secret = (
      await page
        .locator('p:has-text("Or enter this key by hand:") code')
        .innerText()
    ).trim()
    expect(secret, "the manual-entry key").toMatch(/^[A-Z2-7]{16,}$/)

    const backupCodes = (
      await page.locator("ul.font-mono > li").allInnerTexts()
    ).map((code) => code.trim())
    expect(backupCodes.length, "backup codes offered").toBeGreaterThan(0)

    await page.getByLabel("Enter the code to finish").fill(totpCode(secret))
    await submit(page, "Confirm")
    await expect(
      page.getByText("Two-factor authentication is now on.")
    ).toBeVisible()

    // FR-MAIL-1: the owner is told their sign-in requirements changed.
    const notice = await waitForMail(stack, user.email, {
      template: "two-factor-changed",
    })
    expect(notice.subject).toContain("turned on")

    await signOut(page, app)

    // A correct password is no longer a session (FR-2FA-1).
    await signIn(page, app, user.email, user.password)
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/two-factor`))
    await expect(
      page.getByRole("heading", { name: "Two-factor authentication" })
    ).toBeVisible()

    await page.getByLabel("Authentication code").fill(totpCode(secret))
    await submit(page, "Verify")
    await expect(page).toHaveURL(app.url("/account"))

    enrolled = { ...user, secret, backupCodes }
    await signOut(page, app)
  })

  test("a wrong code is refused, and a backup code gets in", async ({
    page,
    app,
  }) => {
    expect(enrolled, "the enrolment test must run first").toBeTruthy()
    const { email, password, backupCodes } = enrolled!

    await signIn(page, app, email, password)
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/two-factor`))

    await page.getByLabel("Authentication code").fill("000000")
    await submit(page, "Verify")
    await expect(page.getByText("That code is not correct.")).toBeVisible()

    // The other way in, for the phone that is not to hand.
    await page.getByRole("link", { name: "Use a backup code instead" }).click()
    await page.getByLabel("Backup code").fill(backupCodes[0]!)
    await submit(page, "Verify")
    await expect(page).toHaveURL(app.url("/account"))
    await signOut(page, app)
  })
})
