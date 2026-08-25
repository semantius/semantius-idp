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
import { waitForMail } from "./stack"

/**
 * The administrative surface (TST-6, FR-ADMIN-2/3, FR-ROLE-2/3).
 *
 * Every test signs in as the bootstrap administrator through the sign-in form,
 * which also means the gate on `/admin/*` is exercised on every one of them
 * rather than in a test of its own.
 */

test.describe("the admin area", () => {
  test("an ordinary user is refused, and told why (FR-ROLE-3)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "notadmin")
    await signIn(page, app, user.email, user.password)

    await app.goto("/admin")
    // Not a redirect back to a form they have already completed: a page.
    await expect(
      page.getByRole("heading", { name: "You do not have access to this" })
    ).toBeVisible()

    await app.goto("/admin/users")
    await expect(
      page.getByRole("heading", { name: "You do not have access to this" })
    ).toBeVisible()
  })

  test("the dashboard counts what is there, and the list searches and pages", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "listed")
    await signInAsAdmin(page, app)

    await app.goto("/admin")
    await expect(
      page.getByRole("heading", { name: "Administration" })
    ).toBeVisible()
    await expect(page.getByText("Live sessions")).toBeVisible()

    await app.goto("/admin/users")
    await page.getByLabel("Search by name or e-mail").fill(user.email)
    await submit(page, "Search")
    await expect(page.getByRole("link", { name: user.email })).toBeVisible()

    // A search that matches nothing says so rather than showing everything.
    await page.getByLabel("Search by name or e-mail").fill("no-such-person")
    await submit(page, "Search")
    await expect(page.getByText("No users match that.")).toBeVisible()

    // Paging needs more rows than the smallest page the server will serve —
    // `pageSize` is clamped to a floor of ten, so `pageSize=1` quietly returns
    // ten and proves nothing. Twelve accounts are seeded through the admin API
    // (FR-ADMIN-6) rather than the form: the assertion is still about the
    // rendered list, and driving the create page twelve times would spend a
    // minute re-testing what the test above already covers.
    const prefix = uniqueEmail("paging").split("@")[0]!
    for (let index = 0; index < 12; index += 1) {
      const created = await page.request.post(
        app.url("/api/auth/admin/create-user"),
        {
          headers: { origin: new URL(app.url("/")).origin },
          data: {
            email: `${prefix}-${index}@example.test`,
            name: `Paging ${index}`,
            password: `${PASSWORD}-${index}`,
            data: { status: "active", emailVerified: true },
          },
        }
      )
      expect(created.ok(), await created.text()).toBe(true)
    }

    // Two halves, asserted separately, because they fail for different
    // reasons: the loader has to honour `page`, and the Next link has to build
    // a URL that says so.
    await app.goto(`/admin/users?q=${prefix}&pageSize=10&page=2`)
    await expect(
      page.locator("tbody tr"),
      "the loader honours the page parameter"
    ).toHaveCount(2)

    await app.goto(`/admin/users?q=${prefix}&pageSize=10`)
    await expect(page.locator("tbody tr")).toHaveCount(10)
    await expect(page.getByText(/1–10 of 12/)).toBeVisible()

    const first = await page.locator("tbody tr td").first().innerText()

    // The link is asserted before it is followed. "The state of the screen is
    // the URL" is the whole design of this page, so a Next that quietly drops
    // the filter is a defect in the link, and clicking first would report it
    // as a wrong row count three assertions later.
    const next = page.getByRole("link", { name: "Next" })
    const href = await next.getAttribute("href")
    expect(href, "the Next link keeps the filter").toContain(`q=${prefix}`)
    expect(href, "the Next link keeps the page size").toContain("pageSize=10")
    expect(href, "the Next link asks for the next page").toContain("page=2")

    await next.click()
    await expect(page, "Next navigated").toHaveURL(/page=2/)
    await expect(page.locator("tbody tr")).toHaveCount(2)
    await expect(page.getByRole("link", { name: "Previous" })).toBeVisible()
    expect(await page.locator("tbody tr td").first().innerText()).not.toBe(
      first
    )
  })

  test("creating a user e-mails them a link to set a password (FR-ADMIN-2)", async ({
    page,
    app,
    stack,
  }) => {
    await signInAsAdmin(page, app)
    const email = uniqueEmail("created")

    await app.goto("/admin/users/new")
    await page.getByLabel("E-mail address").fill(email)
    await page.getByLabel("Name", { exact: true }).fill("Created Person")
    await submit(page, "Create")

    await expect(page.getByText("The account has been created.")).toBeVisible()
    // "It is you doing the vouching": approved and confirmed on creation.
    await expect(page.getByText("Active").first()).toBeVisible()

    const invite = await waitForMail(stack, email, { template: "set-password" })
    expect(invite.subject).toContain("Set up your")
    expect(invite.text).toContain(stack.baseURL)
  })

  test("roles are assigned from the catalog and reach the account (FR-ROLE-2)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "roles")
    await signInAsAdmin(page, app)

    await app.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
    await page.getByRole("link", { name: user.email }).click()

    await page.getByLabel("Roles").fill("user, admin")
    // Scoped to its own form: the temporary-password panel has a "Save" too.
    await page
      .locator('form:has(input[name="roles"])')
      .getByRole("button", { name: "Save" })
      .click()
    await expect(page.getByText("Roles updated.")).toBeVisible()

    await signOut(page, app)
    await signIn(page, app, user.email, user.password)
    // FR-ROLE-2: the claim set is the catalog-filtered list **in catalog
    // order**, whatever order they were typed in — so "user, admin" going in
    // comes back as "admin, user", and a downstream application reading the
    // `roles` claim gets a stable order.
    await expect(page.getByText("admin, user")).toBeVisible()
    // And the role is real: the admin area now opens.
    await app.goto("/admin")
    await expect(
      page.getByRole("heading", { name: "Administration" })
    ).toBeVisible()
  })

  test("suspending an account stops the sign-in and says so (FR-ADMIN-4)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "banned")
    await signInAsAdmin(page, app)

    await app.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
    await page.getByRole("link", { name: user.email }).click()
    await page
      .getByLabel("Reason (recorded, not shown to the user)")
      .fill("Testing the suspension")
    await submit(page, "Suspend")
    await expect(page.getByText("Suspended.")).toBeVisible()

    await signOut(page, app)
    await signIn(page, app, user.email, user.password)
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/banned`))
    await expect(
      page.getByRole("heading", { name: "This account is suspended" })
    ).toBeVisible()
    // FR-ADMIN-4: told, not stonewalled — otherwise the answer to a password
    // that is perfectly correct is to keep retrying it.
    await expect(
      page.getByText("Reason: Testing the suspension")
    ).toBeVisible()

    // Lifting it puts them back.
    await signInAsAdmin(page, app)
    await app.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
    await page.getByRole("link", { name: user.email }).click()
    await submit(page, "Lift the suspension")
    await expect(page.getByText("The suspension has been lifted.")).toBeVisible()

    await signOut(page, app)
    await signIn(page, app, user.email, user.password)
    await expect(page).toHaveURL(app.url("/account"))
    expect(onLogin(page, app)).toBe(false)
  })

  test("an administrator cannot demote the last one (FR-ADMIN-3, D34)", async ({
    page,
    app,
  }) => {
    await signInAsAdmin(page, app)

    await app.goto("/admin/users?q=e2e-admin@example.com")
    await page.getByRole("link", { name: "e2e-admin@example.com" }).click()

    // Both rules fit this account, and the last-administrator one is the
    // answer that names something the reader can do (D34).
    await expect(page.getByRole("button", { name: "Suspend" })).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Delete this account" })
    ).toBeDisabled()
  })

  test("clients and roles are read-only, and the system page describes the deployment", async ({
    page,
    app,
    stack,
  }) => {
    await signInAsAdmin(page, app)

    await app.goto("/admin/clients")
    await expect(page.getByText("E2E App")).toBeVisible()
    await expect(page.getByText("From the file").first()).toBeVisible()
    // FR-OIDC-2: the file is the source of truth, so there is nothing to press.
    await expect(page.getByRole("button", { name: /create|edit|delete/i })).toHaveCount(0)

    await app.goto("/admin/roles")
    await expect(page.getByText("admin").first()).toBeVisible()
    await expect(page.getByText("Given at sign-up").first()).toBeVisible()

    await app.goto("/admin/system")
    await expect(page.getByText(stack.baseURL).first()).toBeVisible()
    // `.first()`: the algorithm is also inside the masked effective
    // configuration further down the page (FR-ADMIN-2).
    await expect(page.getByText("ES256").first()).toBeVisible()

    await app.goto("/admin/audit")
    // SEC-6: sign-ins are on the record, and this run has made plenty.
    // Scoped to the table: the same string is also an <option> in the filter,
    // which is present and invisible, so an unscoped match found that instead.
    await expect(
      page.locator("tbody").getByText("signin.success").first()
    ).toBeVisible()
  })

  test("a temporary password forces a change at the next sign-in (FR-AUTH-4)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "temporary")
    await signInAsAdmin(page, app)

    await app.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
    await page.getByRole("link", { name: user.email }).click()
    await page.getByLabel("Set a temporary password").fill(PASSWORD)
    // Scoped to its own form: the roles panel has a "Save" too, and "the
    // second one on the page" breaks the next time the sidebar is reordered.
    await page
      .locator('form:has(input[name="newPassword"])')
      .getByRole("button", { name: "Save" })
      .click()
    await expect(
      page.getByText("A temporary password is set.")
    ).toBeVisible()

    await signOut(page, app)
    await signIn(page, app, user.email, PASSWORD)
    await expect(page).toHaveURL(/change-password\?forced=1/)
  })
})
