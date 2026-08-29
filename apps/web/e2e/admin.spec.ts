import {
  PASSWORD,
  createVerifiedUser,
  modal,
  onLogin,
  openDialog,
  openMenuDialog,
  openRowLink,
  openRowMenu,
  signIn,
  signInAsAdmin,
  signOut,
  submit,
  submitDialog,
  toast,
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
 * The per-user *confirmations* are dialogs (item 11), so anything after one of
 * those triggers is scoped to the dialog: the trigger and the submit inside it
 * usually share a name, and an unscoped match would find whichever the DOM
 * happened to order first.
 *
 * **Creates and edits are pages** (**D93**), so those flows navigate and then
 * fill the page. That is the difference the specs are asserting as much as the
 * outcome: an address that can be linked to, reloaded and come back to.
 */

test.describe("the admin area", () => {
  test("an ordinary user is refused, and told why (FR-ROLE-3)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "notadmin")
    await signIn(page, app, user.email, user.password)

    const response = await app.goto("/admin")
    // Not a redirect back to a form they have already completed: a page.
    await expect(
      page.getByRole("heading", { name: "You do not have access to this" })
    ).toBeVisible()
    // FR-ROLE-3 says 403, and the page used to render with 200 — asserted at
    // the layer that sees a real document response, the way the 404 is.
    expect(response?.status()).toBe(403)

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
    // **D93**: the page's own name, not the area's. "Administration" was the
    // chrome's `<h1>`; the breadcrumb has that row now and no page carries
    // that string — `t.admin.title` survives only as the nav's `aria-label`.
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
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
    // reasons: the loader has to honor `page`, and the Next link has to build
    // a URL that says so.
    await app.goto(`/admin/users?q=${prefix}&pageSize=10&page=2`)
    await expect(
      page.locator("tbody tr"),
      "the loader honors the page parameter"
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
    // **D93**: the form is a page again, with one address to look at, link to
    // and bookmark. D64's actual finding is untouched and asserted below —
    // both outcomes of the action still land on the list.
    await page.getByRole("link", { name: "Create a user" }).click()
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/users/new`))
    // FR-SIGNUP-5 / D49: two parts, never a free-text display name.
    await page.getByLabel("First name").fill("Created")
    await page.getByLabel("Last name").fill("Person")
    await page.getByLabel("E-mail address").fill(email)
    // D64's *other* half, which D93 does not reverse: the default role arrives
    // ticked, because an unticked form got it anyway — the server falls back
    // to `defaultRole`. Asserted rather than clicked: clicking it now
    // *un*-ticks it.
    await expect(page.getByRole("checkbox", { name: "user" })).toBeChecked()
    await submit(page, "Create")

    // Item 10: both outcomes land on the list the account was created for.
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/users`))
    await expect(page.getByText("The account has been created.")).toBeVisible()
    // **D78**: and *which* account. That sentence is identical for every
    // creation, so an administrator adding several in a row had nothing to
    // tell one confirmation from the next.
    await expect(toast(page).getByText(email)).toBeVisible()
    // The address travelled as a one-shot handle, and both the notice and the
    // handle are stripped once the toast has them: an e-mail address in the
    // query string is one in the request log.
    await expect(page).not.toHaveURL(/notice=|subject=/)

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

  test("a duplicate address is named, not blamed on a password (D70)", async ({
    page,
    app,
    stack,
  }) => {
    // The field report, driven end to end: the form has no password field,
    // and it used to answer that the e-mail and password combination was
    // wrong. Only a browser can assert that, because the whole defect is what
    // the refused form says.
    const user = await createVerifiedUser(page, app, stack, "duplicate")
    await signInAsAdmin(page, app)

    await app.goto("/admin/users/new")
    await page.getByLabel("First name").fill("Second")
    await page.getByLabel("Last name").fill("Attempt")
    await page.getByLabel("E-mail address").fill(user.email)
    await submit(page, "Create")

    // D62: the form comes back with what was typed still in it — at its own
    // address now (**D93**), rather than as a dialog reopened over the list.
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/users/new`))
    await expect(page.getByLabel("E-mail address")).toHaveValue(user.email)
    await expect(
      page.getByText("An account with that e-mail address already exists.")
    ).toBeVisible()
    await expect(
      page.getByText(/e-mail address and password combination/i)
    ).toHaveCount(0)

    // **D93**: and a reload shows a clean, empty form rather than the same
    // message over fields whose values are gone. The draft is single-use, so
    // leaving `?error=` and `?draft=` in the address bar was the D71 defect
    // one parameter over: they are stripped once the loader has claimed them.
    await expect(page).not.toHaveURL(/error=|draft=/)
    await page.reload()
    await expect(page.getByLabel("E-mail address")).toHaveValue("")
    await expect(
      page.getByText("An account with that e-mail address already exists.")
    ).toHaveCount(0)
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

    // **D93**: Edit profile is a link to a page, and the page holds the roles
    // as well — one record, one form, one Save.
    await page.getByRole("link", { name: "Edit profile" }).click()
    await expect(page).toHaveURL(/\/edit$/)
    await page.getByLabel("First name").fill("Corrected")
    await page.getByLabel("Last name").fill("Name")
    await submit(page, "Save")

    // Back on the record, because that is what was edited.
    await expect(page.getByText("The account has been updated.")).toBeVisible()
    await expect(page.getByText("Corrected Name")).toBeVisible()

    // Bookmarkable, which is the premise of the whole change: the edit URL
    // opens the form again, prefilled from the row.
    await page.reload()
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
    // field an administrator has to spell from memory. On the edit page since
    // **D93**, beside the profile fields and under the same Save.
    await page.getByRole("link", { name: "Edit profile" }).click()
    await page.getByRole("checkbox", { name: "admin" }).click()
    await expect(page.getByRole("checkbox", { name: "user" })).toBeChecked()
    await submit(page, "Save")
    await expect(page.getByText("The account has been updated.")).toBeVisible()

    // **D93**: *both* roles survive one save. The join that turns the repeated
    // checkbox field into what `/admin/set-role` takes used to live in the
    // route rather than in the dispatcher, so a second route dispatching
    // `set-roles` without it would have stored one role of two — a silent
    // privilege reduction under a success toast.
    const held = page.locator("main").getByText("admin", { exact: true })
    await expect(held).toBeVisible()
    await expect(
      page.locator("main").getByText("user", { exact: true })
    ).toBeVisible()

    await signOut(page, app)
    await signIn(page, app, user.email, user.password)
    // FR-ROLE-2: the claim set is the catalog-filtered list **in catalog
    // order**, whatever order they were typed in — so "user, admin" going in
    // comes back as "admin, user", and a downstream application reading the
    // `roles` claim gets a stable order.
    await expect(page.getByText("admin, user")).toBeVisible()
    // And the role is real: the admin area now opens. The dashboard's own
    // heading, not the area's — see D93 above.
    await app.goto("/admin")
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
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
    await page.keyboard.press("Escape")

    // **D93**: on your own edit page the roles fieldset is disabled and says
    // why, while the profile half still saves. The guard is on the fieldset
    // and not on the Save, because there is one Save now and disabling it
    // would stop an administrator fixing their own name — which FR-ADMIN-3
    // does not refuse. There was no assertion on any of this before.
    await page.getByRole("link", { name: "Edit profile" }).click()
    await expect(page.getByRole("checkbox", { name: "admin" })).toBeDisabled()
    await expect(
      page.getByText(/You cannot change your own roles/)
    ).toBeVisible()
    await submit(page, "Save")
    await expect(page.getByText("The account has been updated.")).toBeVisible()
  })

  test("a client can be registered, disabled and removed — and file ones cannot (D50)", async ({
    page,
    app,
  }) => {
    await signInAsAdmin(page, app)
    await app.goto("/admin/clients")

    // FR-OIDC-2: a file-managed row is labeled and carries no controls, because
    // an edit here is one the next restart would silently undo.
    const fileRow = page.locator("tbody tr").filter({ hasText: "e2e-app" })
    await expect(fileRow.getByText("From the file")).toBeVisible()
    // **D80**: the four controls are behind one menu now, so the assertion is
    // that the row has no menu at all rather than that it is missing four
    // buttons — a file row must not offer an edit the next restart undoes,
    // and an empty menu would be a worse answer than no menu.
    await expect(
      fileRow.getByRole("button", { name: /^Actions for / })
    ).toHaveCount(0)

    // Registering one: a page since **D93**, and the secret is still
    // generated by the server and shown once in a dialog on the list — never
    // in the address bar.
    await page.getByRole("link", { name: "Add an application" }).click()
    await expect(page).toHaveURL(
      new RegExp(`${app.basePath}/admin/clients/new`)
    )
    await page.getByLabel("Name").fill("Registered Here")
    await page.getByLabel("Client ID").fill("e2e-registered")
    // Explicitly confidential: the form defaults to a single-page app now
    // (round 2, finding 10), and a public client has no secret to show — which
    // is the whole subject of the next twenty lines.
    await page.getByLabel("Type").selectOption("web")
    // `exact`: "Post-logout redirect URIs" contains this label as a substring,
    // and Playwright's `getByLabel` is a substring match by default.
    await page
      .getByLabel("Redirect URIs", { exact: true })
      .fill("http://127.0.0.1:4599/callback")
    await submit(page, "Add an application")

    const secretDialog = modal(page)
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
    // asked for consent. The column exists so that is visible at all — and
    // since round 3 it is headed "Consent required" and reads the way round
    // an administrator thinks, so the default now shows as **No**.
    await expect(row.getByText("No")).toBeVisible()

    // A reload cannot show it again: claiming the stash consumed it.
    await app.goto("/admin/clients")
    expect(await page.content()).not.toContain(secret)

    const menu = await openRowMenu(page, row, "Registered Here")
    await menu.getByRole("menuitem", { name: "Disable" }).click()
    await expect(
      page.getByText("The application has been disabled.")
    ).toBeVisible()
    await expect(row.getByText("Disabled")).toBeVisible()

    const confirm = await openMenuDialog(
      page,
      await openRowMenu(page, row, "Registered Here"),
      "Remove"
    )
    await submitDialog(page, confirm, "Remove")
    await expect(
      page.getByText("The application has been removed.")
    ).toBeVisible()
    await expect(
      page.locator("tbody tr").filter({ hasText: "e2e-registered" })
    ).toHaveCount(0)
  })

  test("a registered application can be edited and its secret rotated (D72)", async ({
    page,
    app,
  }) => {
    await signInAsAdmin(page, app)
    await app.goto("/admin/clients")

    await page.getByRole("link", { name: "Add an application" }).click()
    await page.getByLabel("Name").fill("Editable App")
    await page.getByLabel("Client ID").fill("e2e-editable")
    await page.getByLabel("Type").selectOption("web")
    await page
      .getByLabel("Redirect URIs", { exact: true })
      .fill("http://127.0.0.1:4601/callback")
    await submit(page, "Add an application")

    const created = (
      await modal(page).locator('[data-slot="one-shot-value"]').innerText()
    ).trim()
    await page.keyboard.press("Escape")

    const row = page.locator("tbody tr").filter({ hasText: "e2e-editable" })

    // **D93**: the row's *name* is the way in, not only the menu. That is the
    // whole point of an addressable record — Edit used to exist solely inside
    // the per-row menu, which is the first, pinned column.
    await row.getByRole("link", { name: "Editable App" }).click()
    await expect(page).toHaveURL(/\/admin\/clients\/e2e-editable\/edit$/)

    // The edit page arrives **prefilled**, which is the half a unit test
    // cannot see and the half that matters: `/idp/update-client` is a full
    // replace, so a field that came back blank would be a field that saving
    // clears.
    await expect(page.getByLabel("Name")).toHaveValue("Editable App")
    await expect(
      page.getByLabel("Redirect URIs", { exact: true })
    ).toHaveValue("http://127.0.0.1:4601/callback")
    // Shown and not editable: the id is the natural key four other tables
    // reference, so changing it is removing this application and adding a
    // different one.
    await expect(page.locator("main").getByText("e2e-editable")).toBeVisible()

    // …and it survives a reload and a Back, which is what "one address" buys.
    await page.reload()
    await expect(page.getByLabel("Name")).toHaveValue("Editable App")

    await page.getByLabel("Name").fill("Edited App")
    await page
      .getByLabel("Redirect URIs", { exact: true })
      .fill("http://127.0.0.1:4601/moved")
    await submit(page, "Save")

    await expect(
      page.getByText("The application has been updated.")
    ).toBeVisible()
    await expect(row.getByText("Edited App")).toBeVisible()
    await expect(row.getByText("http://127.0.0.1:4601/moved")).toBeVisible()

    // Rotation: a new secret, shown once, in a dialog and never in the URL.
    const rotate = await openMenuDialog(
      page,
      await openRowMenu(page, row, "Edited App"),
      "Rotate secret"
    )
    await submitDialog(page, rotate, "Rotate secret")

    const secretDialog = modal(page)
    await expect(secretDialog).toBeVisible()
    const rotated = (
      await secretDialog.locator('[data-slot="one-shot-value"]').innerText()
    ).trim()
    expect(rotated.length, "a generated client secret").toBeGreaterThan(31)
    expect(rotated, "a new secret, not the one from the create").not.toBe(
      created
    )
    expect(page.url(), "the secret is not in the URL").not.toContain(rotated)
    await page.keyboard.press("Escape")

    // Cleaned up, so the next run of this spec starts from the same table.
    const confirm = await openMenuDialog(
      page,
      await openRowMenu(page, row, "Edited App"),
      "Remove"
    )
    await submitDialog(page, confirm, "Remove")
    await expect(
      page.locator("tbody tr").filter({ hasText: "e2e-editable" })
    ).toHaveCount(0)
  })

  test("a gateway can be added, disabled and removed — and file ones cannot (D91)", async ({
    page,
    app,
  }) => {
    await signInAsAdmin(page, app)
    await app.goto("/admin/gateways")

    // FR-GW-2: the config-declared row is labeled and carries no menu at all,
    // because an edit here is one the next restart would silently undo. The
    // same assertion D50's client test makes, and for the same reason.
    const fileRow = page.locator("tbody tr").filter({ hasText: "fromfile" })
    await expect(fileRow.getByText("From the file")).toBeVisible()
    await expect(
      fileRow.getByRole("button", { name: /^Actions for / })
    ).toHaveCount(0)

    // **D92**: the config row forwards the edge's headers, and the column says
    // so — the one place an operator can check what an upstream is told.
    await expect(fileRow.getByText("From the proxy")).toBeVisible()

    await page.getByRole("link", { name: "Add a gateway" }).click()
    await expect(page).toHaveURL(
      new RegExp(`${app.basePath}/admin/gateways/new`)
    )
    await page.getByLabel("Name").fill("e2e-gateway")
    // A **bare origin**, which is the common shape and the one the first
    // commit of this series fixed: the list used to normalize it to
    // `http://upstream.invalid:9999/` on the way out, and Edit then refused a
    // save for a trailing slash the operator never typed.
    await page.getByLabel("Target URL").fill("http://upstream.invalid:9999")
    await submit(page, "Add a gateway")
    await expect(page.getByText("The gateway has been added.")).toBeVisible()

    const row = page.locator("tbody tr").filter({ hasText: "e2e-gateway" })
    await expect(row.getByText("Added here")).toBeVisible()
    await expect(row.getByText("Enabled")).toBeVisible()
    // Both flags default off, and the table is where that is visible.
    await expect(row.getByText("Anonymous allowed")).toBeVisible()
    await expect(row.getByText("From this server")).toBeVisible()
    // The path a caller configures, shown beside the name — the one thing an
    // operator has to copy off this page.
    await expect(row.getByText("/gateway/e2e-gateway")).toBeVisible()

    // Commit 1, end to end: the target reads back byte-identical, so Edit
    // opens with no trailing slash and a save that changes only a checkbox is
    // accepted rather than refused for a slash nobody typed.
    await openRowLink(page, row, "e2e-gateway", "Edit")
    await expect(page.getByLabel("Target URL")).toHaveValue(
      "http://upstream.invalid:9999"
    )
    await page.getByRole("checkbox", { name: "Require authentication" }).click()
    await submit(page, "Save")
    await expect(page.getByText("The gateway has been updated.")).toBeVisible()
    await expect(row.getByText("Required")).toBeVisible()

    const menu = await openRowMenu(page, row, "e2e-gateway")
    await menu.getByRole("menuitem", { name: "Disable" }).click()
    await expect(
      page.getByText("The gateway has been disabled.")
    ).toBeVisible()
    await expect(row.getByText("Disabled")).toBeVisible()

    const confirm = await openMenuDialog(
      page,
      await openRowMenu(page, row, "e2e-gateway"),
      "Remove"
    )
    await submitDialog(page, confirm, "Remove")
    await expect(page.getByText("The gateway has been removed.")).toBeVisible()
    await expect(
      page.locator("tbody tr").filter({ hasText: "e2e-gateway" })
    ).toHaveCount(0)
  })

  test("a file-managed row's edit URL lands on the list with a reason (D93)", async ({
    page,
    app,
  }) => {
    // Not `notFound()`, which is a centered page with no sidebar and no link
    // out, replying "this does not exist" about a row that is visible on the
    // list. The write itself must still be impossible — the next restart would
    // undo it (FR-OIDC-2, FR-GW-2) — so the refusal is a redirect carrying the
    // reason, which is the shape every other refusal on those pages uses.
    await signInAsAdmin(page, app)

    await app.goto("/admin/clients/e2e-app/edit")
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/clients`))
    await expect(
      page.getByText(/comes from oauth_clients\.jsonc/)
    ).toBeVisible()

    await app.goto("/admin/gateways/fromfile/edit")
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/gateways`))
    await expect(page.getByText(/comes from config\.jsonc/)).toBeVisible()
  })

  test("leaving a form with unsaved changes asks first (D93)", async ({
    page,
    app,
  }) => {
    // The hazard the move to pages makes bigger rather than creates: Escape
    // already discarded a dialog, but since **D82** the sidebar is permanently
    // on screen with eight one-click destinations, D93 adds a breadcrumb with
    // two more, and Back now means something. A redirect-URI list is copied
    // out of another system, and **D62** built an entire one-shot draft stash
    // so a *server refusal* would not cost it.
    await signInAsAdmin(page, app)
    await app.goto("/admin/clients/new")

    // **Scoped to the sidebar's landmark.** Since **D93** the breadcrumb
    // carries a link with the same name on this very page — `t.admin.title`
    // survives exactly here, as the navigation's `aria-label`, so it is what
    // tells the two apart.
    const nav = page.getByRole("navigation", { name: "Administration" })

    // A clean form does not ask. Asserted first, because a guard that blocked
    // everything would pass the interesting half of this test.
    await nav.getByRole("link", { name: "Applications" }).click()
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/clients$`))

    await app.goto("/admin/clients/new")
    await page.getByLabel("Name").fill("Half Typed")
    await nav.getByRole("link", { name: "Users" }).click()

    const asked = modal(page)
    await expect(asked).toBeVisible()
    await expect(asked.getByText(/have not been saved/)).toBeVisible()

    // Cancel opts out: still here, and still holding what was typed.
    await asked.getByRole("button", { name: "Stay on this page" }).click()
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/clients/new`))
    await expect(page.getByLabel("Name")).toHaveValue("Half Typed")

    // …and the other answer really does leave.
    await nav.getByRole("link", { name: "Users" }).click()
    await modal(page).getByRole("button", { name: "Discard and leave" }).click()
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/users`))
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

  test("a deleted account is named, and the confirmation does not outlive it (D78)", async ({
    page,
    app,
    stack,
  }) => {
    const user = await createVerifiedUser(page, app, stack, "deleted")
    await signInAsAdmin(page, app)

    await app.goto("/admin/users")
    await page.getByLabel("Search by name or e-mail").fill(user.email)
    await submit(page, "Search")
    await page.getByRole("link", { name: user.email }).click()

    const remove = await openDialog(page, "Delete this account")
    await submitDialog(page, remove, "Delete this account")

    // The account's own page is gone with it, so this lands on the list —
    // where the row that could answer "which one?" is exactly what is missing.
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/users`))
    const confirmation = toast(page)
    await expect(
      confirmation.getByText("The account has been deleted.")
    ).toBeVisible()
    await expect(confirmation.getByText(user.email)).toBeVisible()
    await expect(page).not.toHaveURL(/notice=|subject=/)

    // **D78**, the other half. Base UI freezes every auto-dismiss timer while
    // the *window* is unfocused and thaws it only on the way back, so a
    // confirmation left behind a switched-away window stays on screen for as
    // long as the absence lasts — the outliving-its-truth D71 set out to end,
    // reintroduced by the component that replaced the banner. Only a browser
    // can see this: the blur is a real window event and the dismissal is a
    // real timer.
    await page.evaluate(() => {
      window.dispatchEvent(new FocusEvent("blur"))
    })
    await expect(
      confirmation,
      "the toast goes even though the window never came back"
    ).toHaveCount(0, { timeout: 25_000 })
  })

  test("a public client says why it has no secret, and how to get one (D78)", async ({
    page,
    app,
  }) => {
    await signInAsAdmin(page, app)
    await app.goto("/admin/clients")

    await page.getByRole("link", { name: "Add an application" }).click()
    // The type is the only control that decides whether a secret exists, and
    // — on the edit page — the only way to give one to an application that
    // has none. Neither was said anywhere.
    await expect(
      page.getByText(/Only a Web application keeps a client secret/)
    ).toBeVisible()

    await page.getByLabel("Name").fill("Public Only")
    await page.getByLabel("Client ID").fill("e2e-public")
    // **The default type, left alone.** This is the registration an operator
    // actually makes, and the one that produced a bare "The application has
    // been registered.", no secret dialog and no rotate control, with nothing
    // anywhere connecting the three.
    await expect(page.getByLabel("Type")).toHaveValue("spa")
    await page
      .getByLabel("Redirect URIs", { exact: true })
      .fill("https://example.test/callback")
    await submit(page, "Add an application")

    await expect(
      page.getByText(/It is a public client, so it has no secret/)
    ).toBeVisible()
    // No secret dialog, because there is no secret. The point is that the
    // page says so rather than looking like a dialog that failed to open.
    await expect(modal(page)).toHaveCount(0)

    const row = page.locator("tbody tr").filter({ hasText: "e2e-public" })
    await expect(row.getByText("Public — no client secret")).toBeVisible()
    const publicMenu = await openRowMenu(page, row, "Public Only")
    await expect(
      publicMenu.getByRole("menuitem", { name: "Rotate secret" })
    ).toHaveCount(0)

    await page.keyboard.press("Escape")

    // The way out, which is the answer to "the option to change the secret is
    // missing": the type change mints one and shows it once, and the row
    // grows the rotate control it did not have.
    await openRowLink(page, row, "Public Only", "Edit")
    // Scoped to `main`: the creation's confirmation toast is still on screen
    // for ten seconds (**D71**), its accessible name is the whole sentence,
    // and "Change its **type** to Web to issue one" makes `getByLabel("Type")`
    // match the toast as well as the field. The toast is portalled outside
    // `<main>`; the form is not.
    await page.locator("main").getByLabel("Type").selectOption("web")
    await submit(page, "Save")

    const issued = modal(page)
    await expect(issued).toBeVisible()
    const secret = (
      await issued.locator('[data-slot="one-shot-value"]').innerText()
    ).trim()
    expect(secret.length, "a generated client secret").toBeGreaterThan(31)
    await page.keyboard.press("Escape")
    const confidentialMenu = await openRowMenu(page, row, "Public Only")
    await expect(
      confidentialMenu.getByRole("menuitem", { name: "Rotate secret" })
    ).toBeVisible()

    // Cleaned up, so the next run starts from the same table.
    const confirm = await openMenuDialog(page, confidentialMenu, "Remove")
    await submitDialog(page, confirm, "Remove")
    await expect(
      page.locator("tbody tr").filter({ hasText: "e2e-public" })
    ).toHaveCount(0)
  })
})
