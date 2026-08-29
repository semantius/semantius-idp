import {
  onLogin,
  openDialog,
  openMailLink,
  PASSWORD,
  register,
  signIn,
  signInAsAdmin,
  signOut,
  submitDialog,
  uniqueEmail,
} from "./actions"
import { expect, test } from "./fixtures"
import { reconfigure, resetConfig, waitForMail } from "./stack"

/**
 * Registration, verification and the approval queue (TST-6, FR-SIGNUP-1/2,
 * FR-AUTH-2).
 *
 * **Serial, and it reconfigures the stack.** Sign-up on/off and approval
 * on/off are configuration, read once at start-up with no hot reload (CFG-5),
 * so the honest way to drive both is to write a different `config.jsonc` and
 * restart the container — which is also what an operator does. The database
 * survives the restart, so an account registered under one configuration is
 * still there under the next.
 *
 * `afterAll` puts the configuration back. Every other spec file assumes the
 * defaults `e2e/stack.ts` writes, and a file that left the stack changed would
 * make the suite depend on the order Playwright walked it in.
 */

test.describe.configure({ mode: "serial" })

test.describe("signing up", () => {
  test.afterAll(async ({ stack }) => {
    await resetConfig(stack)
  })

  test("register, confirm the address, sign in (FR-SIGNUP-1, FR-AUTH-2)", async ({
    page,
    app,
    stack,
  }) => {
    const email = uniqueEmail("signup")
    await register(page, app, {
      email,
      firstName: "Sam",
      lastName: "Signup",
    })

    // The page says what happens next rather than pretending the account works.
    await expect(page).toHaveURL(/verify-email/)
    await expect(page.getByText(email)).toBeVisible()

    // SEC-1: the link in the message is built from `server.baseUrl`, so it
    // points back at this deployment including its mount path.
    const mail = await waitForMail(stack, email, { template: "verify-email" })
    expect(mail.subject).toContain("E2E IdP")
    expect(mail.text).toContain(stack.baseURL)

    await openMailLink(page, stack, email, "verify-email")
    await expect(
      page.getByText("Your e-mail address is confirmed.")
    ).toBeVisible()

    await signIn(page, app, email, PASSWORD)
    await expect(page).toHaveURL(app.url("/account"))
    // FR-SIGNUP-5 / D49: the parts are prefilled, and the display name is
    // derived from them rather than being a field of its own.
    await expect(page.getByLabel("First name")).toHaveValue("Sam")
    await expect(page.getByLabel("Last name")).toHaveValue("Signup")
    // The footer, not `main`: **D95** took the read-only display name off the
    // form, because since **D82** the shell already carries it on every page
    // of the area. `account.spec.ts` moved with it and this assertion — the
    // same one, made about a self-registered account — was missed.
    await expect(
      page.locator('[data-slot="sidebar-footer"]').getByText("Sam Signup")
    ).toBeVisible()
    await signOut(page, app)
  })

  test("with sign-up off there is no link, no page and no endpoint (FR-SIGNUP-1)", async ({
    page,
    app,
    stack,
  }) => {
    test.slow()
    await reconfigure(stack, { signUp: { enabled: false } })

    await app.goto("/login")
    await expect(
      page.getByRole("link", { name: "Create account" })
    ).toHaveCount(0)

    // Not a disabled form — the page does not exist, so a curious visitor is
    // given nothing to work with.
    const response = await app.goto("/signup")
    expect(response?.status()).toBe(404)
    await expect(page.getByText("Page not found")).toBeVisible()

    // And the POST is as absent as the page: a hand-made submission to the
    // route gets the same 404, not a registration.
    const posted = await page.request.post(app.url("/signup"), {
      form: { email: uniqueEmail("sneaky"), password: PASSWORD },
      maxRedirects: 0,
    })
    expect(posted.status()).toBe(404)
  })

  test("with approval on the account waits, and an administrator lets it in (FR-SIGNUP-2)", async ({
    page,
    app,
    stack,
  }) => {
    test.slow()
    await reconfigure(stack, {
      signUp: { enabled: true, requireApproval: true },
    })

    const email = uniqueEmail("approval")
    await register(page, app, { email, firstName: "Pat", lastName: "Pending" })

    await expect(page).toHaveURL(new RegExp(`${app.basePath}/pending-approval`))
    await expect(
      page.getByRole("heading", { name: "Waiting for approval" })
    ).toBeVisible()

    // Confirming the address is not the gate — approval is.
    await openMailLink(page, stack, email, "verify-email")
    await signIn(page, app, email, PASSWORD)
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/pending-approval`))

    // The administrators were told there is something to look at (FR-MAIL-1).
    const notice = await waitForMail(stack, "e2e-admin@example.com", {
      template: "pending-signup",
    })
    expect(notice.text).toContain(email)

    await signInAsAdmin(page, app)
    await app.goto(`/admin/users?q=${encodeURIComponent(email)}`)
    await page.getByRole("link", { name: email }).click()
    await expect(page.getByText("Pending").first()).toBeVisible()

    // Item 11: the actions are dialogs now, so approving is two clicks and the
    // second one is scoped to the dialog — the trigger shares its name.
    const approve = await openDialog(page, "Approve")
    await submitDialog(page, approve, "Approve")
    await expect(page.getByText("Approved.")).toBeVisible()
    await signOut(page, app)

    // The decision reaches the person waiting on it.
    const approved = await waitForMail(stack, email, {
      template: "account-approved",
    })
    expect(approved.subject).toContain("ready")

    await signIn(page, app, email, PASSWORD)
    await expect(page).toHaveURL(app.url("/account"))
    expect(onLogin(page, app)).toBe(false)
  })
})
