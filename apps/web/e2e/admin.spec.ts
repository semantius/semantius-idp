import {
  PASSWORD,
  createVerifiedUser,
  onLogin,
  openDialog,
  signIn,
  signInAsAdmin,
  signOut,
  submit,
  submitDialog,
  uniqueEmail,
} from "./actions"
import { expect, test } from "./fixtures"
import { waitForMail } from "./stack"

/**
 * The administrative surface (TST-6, FR-ADMIN-2/3, FR-ROLE-2/3).
 *
 * Every test signs in as the administrator the first-run wizard created
 * (D52) through the sign-in form, which also means the gate on `/admin/*` is
 * exercised on every one of them rather than in a test of its own.
 *
 * The per-user actions are dialogs now (item 11), so anything after the trigger
 * is scoped to the dialog: the trigger and the submit inside it usually share a
 * name, and an unscoped match would find whichever the DOM happened to order
 * first.
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

  test("creating a user lands on the list and e-mails them a link (FR-ADMIN-2, FR-SIGNUP-5)", async ({
    page,
    app,
    stack,
  }) => {
    await signInAsAdmin(page, app)
    const email = uniqueEmail("created")

    await app.goto("/admin/users")
    // D64: the form is a dialog on the list, not a page of its own — both
    // outcomes of the action now live where the account does.
    const form = await openDialog(page, "Create a user")
    // FR-SIGNUP-5 / D49: two parts, never a free-text display name.
    await form.getByLabel("First name").fill("Created")
    await form.getByLabel("Last name").fill("Person")
    await form.getByLabel("E-mail address").fill(email)
    // D64: the default role arrives ticked, because an unticked form got it
    // anyway — the server falls back to `defaultRole`. Asserted rather than
    // clicked: clicking it now *un*-ticks it.
    await expect(form.getByRole("checkbox", { name: "user" })).toBeChecked()
    await submitDialog(page, form, "Create")

    // Item 10: both outcomes land on the list the account was created for.
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/users`))
    await expect(page.getByText("The account has been created.")).toBeVisible()

    await page.getByLabel("Search by name or e-mail").fill(email)
    await submit(page, "Search")
    await expect(page.getByRole("link", { name: email })).toBeVisible()
    // The derived name, in `site.nameFormat` order (D49).
    await expect(page.getByText("Created Person")).toBeVisible()
    // "It is you doing the vouching": approved and confirmed on creation.
    // Scoped to the table: "Active" is also an <option> in the status filter,
    // which sits *earlier* in the DOM and is not visible inside a closed
    // select — so an unscoped `.first()` matches that and fails.
    await expect(
      page.locator("tbody").getByText("Active").first()
    ).toBeVisible()

    const invite = await waitForMail(stack, email, { template: "set-password" })
    expect(invite.subject).toContain("Set up your")
    expect(invite.text).toContain(stack.baseURL)
  })

  test("an administrator can correct a profile (FR-ADMIN-2, D49)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "edited")
    await signInAsAdmin(page, app)

    await app.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
    await page.getByRole("link", { name: user.email }).click()

    const dialog = await openDialog(page, "Edit profile")
    await dialog.getByLabel("First name").fill("Corrected")
    await dialog.getByLabel("Last name").fill("Name")
    await submitDialog(page, dialog, "Save")

    await expect(page.getByText("Profile updated.")).toBeVisible()
    await expect(page.getByText("Corrected Name")).toBeVisible()
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

    // Item 11b: one checkbox per catalog role rather than a comma-separated
    // field an administrator has to spell from memory.
    const roles = await openDialog(page, "Roles")
    await roles.getByRole("checkbox", { name: "admin" }).click()
    await expect(roles.getByRole("checkbox", { name: "user" })).toBeChecked()
    await submitDialog(page, roles, "Save")
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
    const ban = await openDialog(page, "Suspend")
    await ban
      .getByLabel("Reason (recorded, not shown to the user)")
      .fill("Testing the suspension")
    await submitDialog(page, ban, "Suspend")
    await expect(page.getByText("Suspended.")).toBeVisible()

    await signOut(page, app)
    await signIn(page, app, user.email, user.password)
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/banned`))
    await expect(
      page.getByRole("heading", { name: "This account is suspended" })
    ).toBeVisible()
    // FR-ADMIN-4: told, not stonewalled — otherwise the answer to a password
    // that is perfectly correct is to keep retrying it.
    await expect(page.getByText("Reason: Testing the suspension")).toBeVisible()

    // Lifting it puts them back.
    await signInAsAdmin(page, app)
    await app.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
    await page.getByRole("link", { name: user.email }).click()
    const unban = await openDialog(page, "Lift the suspension")
    await submitDialog(page, unban, "Lift the suspension")
    await expect(
      page.getByText("The suspension has been lifted.")
    ).toBeVisible()

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
    // answer that names something the reader can do (D34). The controls live
    // inside their dialogs now, so the refusal is asserted where it is shown.
    const ban = await openDialog(page, "Suspend")
    await expect(ban.getByRole("button", { name: "Suspend" })).toBeDisabled()
    await page.keyboard.press("Escape")

    const remove = await openDialog(page, "Delete this account")
    await expect(
      remove.getByRole("button", { name: "Delete this account" })
    ).toBeDisabled()
    // The confirmation is the dialog's own text, not a sentence above a bare
    // button that fires on the first click.
    await expect(remove.getByText("This cannot be undone.")).toBeVisible()
  })

  test("a client can be registered, disabled and removed — and file ones cannot (D50)", async ({
    page,
    app,
  }) => {
    await signInAsAdmin(page, app)
    await app.goto("/admin/clients")

    // FR-OIDC-2: a file-managed row is labelled and carries no controls, because
    // an edit here is one the next restart would silently undo.
    const fileRow = page.locator("tbody tr").filter({ hasText: "e2e-app" })
    await expect(fileRow.getByText("From the file")).toBeVisible()
    await expect(fileRow.getByRole("button", { name: "Remove" })).toHaveCount(0)
    await expect(fileRow.getByRole("button", { name: "Disable" })).toHaveCount(
      0
    )

    // Registering one: the secret is generated here and shown once, in a
    // dialog, and never in the address bar.
    const form = await openDialog(page, "Add an application")
    await form.getByLabel("Name").fill("Registered Here")
    await form.getByLabel("Client ID").fill("e2e-registered")
    // Explicitly confidential: the dialog defaults to a single-page app now
    // (round 2, finding 10), and a public client has no secret to show — which
    // is the whole subject of the next twenty lines.
    await form.getByLabel("Type").selectOption("web")
    // `exact`: "Post-logout redirect URIs" contains this label as a substring,
    // and Playwright's `getByLabel` is a substring match by default.
    await form
      .getByLabel("Redirect URIs", { exact: true })
      .fill("http://127.0.0.1:4599/callback")
    await submitDialog(page, form, "Add an application")

    const secretDialog = page.getByRole("dialog")
    await expect(secretDialog).toBeVisible()
    const secret = (
      await secretDialog.locator('[data-slot="one-shot-value"]').innerText()
    ).trim()
    expect(secret.length, "a generated client secret").toBeGreaterThan(31)
    expect(page.url(), "the secret is not in the URL").not.toContain(secret)
    await page.keyboard.press("Escape")

    const row = page.locator("tbody tr").filter({ hasText: "e2e-registered" })
    await expect(row.getByText("Added here")).toBeVisible()
    await expect(row.getByText("Enabled")).toBeVisible()
    // FR-OIDC-3's default, restored: the create handler used to send a defined
    // `false` from a checkbox that did not exist, so every client added here
    // asked for consent. The column exists so that is visible at all.
    await expect(row.getByText("Yes")).toBeVisible()

    // A reload cannot show it again: claiming the stash consumed it.
    await app.goto("/admin/clients")
    expect(await page.content()).not.toContain(secret)

    await row.getByRole("button", { name: "Disable" }).click()
    await expect(
      page.getByText("The application has been disabled.")
    ).toBeVisible()
    await expect(row.getByText("Disabled")).toBeVisible()

    const confirm = await openDialog(page, "Remove")
    await submitDialog(page, confirm, "Remove")
    await expect(
      page.getByText("The application has been removed.")
    ).toBeVisible()
    await expect(
      page.locator("tbody tr").filter({ hasText: "e2e-registered" })
    ).toHaveCount(0)
  })

  test("roles are read-only, and the system page describes the deployment", async ({
    page,
    app,
    stack,
  }) => {
    await signInAsAdmin(page, app)

    await app.goto("/admin/roles")
    await expect(page.getByText("admin").first()).toBeVisible()
    await expect(page.getByText("Given at sign-up").first()).toBeVisible()

    await app.goto("/admin/system")
    await expect(page.getByText(stack.baseURL).first()).toBeVisible()
    // `.first()`: the algorithm is also inside the masked effective
    // configuration further down the page (FR-ADMIN-2).
    await expect(page.getByText("ES256").first()).toBeVisible()

    // D55: the discovery URLs, absolute. This assertion is why the test runs
    // in both deployment shapes — under a sub-path *two* metadata URLs are
    // correct and they are not the same one, and only one of them is
    // derivable from the issuer by appending to it.
    // The link's accessible name is the URL itself, which is the point: it is
    // there to be read and copied.
    await expect(
      page.getByRole("link", {
        name: `${stack.baseURL}/.well-known/openid-configuration`,
      })
    ).toBeVisible()

    const { origin, pathname } = new URL(stack.baseURL)
    const subPath = pathname.replace(/\/$/, "")
    if (subPath !== "") {
      // Both origin-root spellings, because `Caddyfile.subpath` rewrites both.
      // The well-known segment goes *in front of* the path, so neither of
      // these is the URL above with a suffix — they are a different shape, and
      // the reverse proxy is what serves them.
      for (const wellKnown of [
        "oauth-authorization-server",
        "openid-configuration",
      ]) {
        await expect(
          page.getByRole("link", {
            name: `${origin}/.well-known/${wellKnown}${subPath}`,
          })
        ).toBeVisible()
      }
    }

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
    const temporary = await openDialog(page, "Set a temporary password")
    await temporary.getByLabel("Set a temporary password").fill(PASSWORD)
    await submitDialog(page, temporary, "Save")
    await expect(page.getByText("A temporary password is set.")).toBeVisible()

    await signOut(page, app)
    await signIn(page, app, user.email, PASSWORD)
    await expect(page).toHaveURL(/change-password\?forced=1/)
  })
})
