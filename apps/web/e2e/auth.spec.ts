import {
  PASSWORD,
  createVerifiedUser,
  onLogin,
  signIn,
  signInAsAdmin,
  signOut,
  submit,
  uniqueEmail,
} from "./actions"
import { expect, test } from "./fixtures"

/**
 * Password sign-in, end to end (TST-6, FR-AUTH-1/4/6).
 *
 * These drive the **rendered pages** against the built image, which is what
 * separates them from `integration/auth-lifecycle.test.ts`: that suite calls
 * `auth.handler` and knows nothing about whether a form exists, submits, or
 * lands anywhere. Both are worth having, and this is the one that fails when
 * the button stops being a button.
 */

test.describe("signing in", () => {
  test("a wrong password says so and changes nothing (SEC-7)", async ({
    page,
    app,
  }) => {
    await signIn(page, app, "nobody@example.test", "not-the-password")

    expect(onLogin(page, app), "still on the sign-in page").toBe(true)
    // The same wording for a wrong password and an address that does not
    // exist — the requirement, not an accident of this fixture.
    await expect(
      page.getByText(
        "That e-mail address and password combination is not correct."
      )
    ).toBeVisible()

    // And no session was created: the account area still refuses.
    await app.goto("/account")
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/login`))
  })

  test("the administrator the first-run wizard created can sign in (D52)", async ({
    page,
    app,
  }) => {
    // The account was made at `/setup`, in a browser, by `globalSetup`. It
    // carries no forced change — the person who chose the password is the one
    // using it — so this is an ordinary sign-in and nothing interposes.
    await signInAsAdmin(page, app)
    await expect(
      page.getByRole("heading", { name: "Your account" })
    ).toBeVisible()
  })

  test("the first-run wizard is gone once the deployment has a user (D52)", async ({
    page,
    app,
  }) => {
    // The security-relevant half of the gate: the page that creates an
    // administrator without authenticating anybody must not be reachable on a
    // deployment that already has users, or losing the last administrator
    // would be an escalation rather than a lockout.
    await app.goto("/setup")
    await expect(page).toHaveURL(app.url("/login"))
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible()

    // And the root now leads to the sign-in form rather than to setup.
    await app.goto("/")
    await expect(page).toHaveURL(app.url("/login"))
  })

  test("a verified user signs in, and signing out ends it (FR-AUTH-6)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "signin")

    await signIn(page, app, user.email, user.password)
    await expect(page).toHaveURL(app.url("/account"))
    // `main`, not the page: the sidebar footer carries the address too (D82).
    await expect(page.locator("main").getByText(user.email)).toBeVisible()

    await signOut(page, app)
    await expect(page).toHaveURL(/notice=signed_out/)
    await expect(page.getByText("You have been signed out.")).toBeVisible()

    // The cookie is gone, not merely forgotten by the page.
    await app.goto("/account")
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/login`))
  })

  test("an unverified account cannot sign in (FR-AUTH-2)", async ({
    page,
    app,
  }) => {
    const email = uniqueEmail("unverified")
    await app.goto("/signup")
    await page.getByLabel("E-mail address").fill(email)
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD)
    await submit(page, "Create account")
    // Sign-up lands on "check your inbox" rather than on a session.
    await expect(page).toHaveURL(/verify-email/)

    await signIn(page, app, email, PASSWORD)
    expect(onLogin(page, app)).toBe(true)
  })

  test("reaching the account area anonymously asks for a sign-in and comes back", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "returnto")

    await app.goto("/account/sessions")
    await expect(page).toHaveURL(/returnTo=/)
    await expect(page.getByText("Sign in to continue.")).toBeVisible()

    await page.getByLabel("E-mail address").fill(user.email)
    await page.getByLabel("Password", { exact: true }).fill(user.password)
    await submit(page, "Sign in")

    // SEC-3: `returnTo` is a same-origin relative path, and it is honoured.
    await expect(page).toHaveURL(app.url("/account/sessions"))
  })
})
