import { signInAsAdmin } from "./actions"
import { expect, test } from "./fixtures"
import { reconfigure, resetConfig } from "./stack"

/**
 * `/admin/database` — the console, and the flag that decides it exists
 * (FR-ADMIN-7, TST-6).
 *
 * Its own file rather than a block in `admin.spec.ts` for one reason: two of
 * these tests change `admin.database` and restart the container, so the whole
 * file has to be serial and has to put the configuration back in `afterAll`.
 * Making `admin.spec.ts` serial to accommodate them would slow every admin
 * test down for the benefit of two — the same argument `signup.spec.ts` makes,
 * and the same shape.
 *
 * The base stack runs `read-only`, so the first two tests need no restart at
 * all and the reconfigures are grouped at the end.
 */

test.describe.configure({ mode: "serial" })

test.describe("the database console", () => {
  test.afterAll(async ({ stack }) => {
    await resetConfig(stack)
  })

  test("explores the schema and runs a statement", async ({ page, app }) => {
    await signInAsAdmin(page, app)
    await app.goto("/admin/database")

    await expect(
      page.getByRole("heading", { name: "Database", exact: true })
    ).toBeVisible()

    // The tree is `role="tree"` with a `treeitem` per table -- the schema came
    // from a real `information_schema` walk of the running container, so a
    // table this application actually has is the honest assertion.
    await expect(
      page.getByRole("treeitem", { name: /user/ }).first()
    ).toBeVisible()

    // CodeMirror renders a contenteditable, not a textarea, so it is typed
    // into rather than filled. `aria-label` is the component's own.
    const editor = page.getByRole("textbox", { name: "SQL query" })
    await editor.click()
    // 42 rather than 1: the grid puts a row *number* in the first cell of every
    // row, so a one-row `select 1` produces two cells reading "1" and
    // Playwright's strict mode fails the test rather than the assertion.
    await page.keyboard.type("select 42 as answer")
    await page.getByRole("button", { name: /^Run/ }).click()

    // The column header and the value: together they are the only proof the
    // statement reached Postgres rather than being echoed back.
    await expect(
      page.getByRole("columnheader", { name: /answer/ })
    ).toBeVisible()
    await expect(
      page.getByRole("cell", { name: "42", exact: true })
    ).toBeVisible()
  })

  test("refuses a write with the database's own error (25006)", async ({
    page,
    app,
  }) => {
    await signInAsAdmin(page, app)
    await app.goto("/admin/database")

    const editor = page.getByRole("textbox", { name: "SQL query" })
    await editor.click()
    await page.keyboard.type(`delete from "user" where id = 'nobody'`)
    await page.getByRole("button", { name: /^Run/ }).click()

    // The transaction refused it, not the editor: a `read-only` deployment
    // pins the runner to `read-write` precisely so the statement is *sent* and
    // the answer is Postgres's, with a SQLSTATE the operator can look up.
    const error = page.locator('[data-slot="sql-runner-error"]')
    await expect(error).toBeVisible()
    await expect(error).toContainText("25006")
  })

  test("with the flag off there is no entry, no page and no endpoint", async ({
    page,
    app,
    stack,
  }) => {
    test.slow()
    await reconfigure(stack, { admin: { database: "disabled" } })
    await signInAsAdmin(page, app)

    await app.goto("/admin")
    // The sibling entry first: `toHaveCount(0)` on its own would also pass
    // against a sidebar that failed to render at all, or one collapsed to the
    // icon rail, where the labels are `display: none` and out of the
    // accessibility tree.
    await expect(page.getByRole("link", { name: "System" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Database" })).toHaveCount(0)

    const response = await app.goto("/admin/database")
    expect(response?.status()).toBe(404)
    await expect(page.getByText("Page not found")).toBeVisible()

    // The owner's explicit requirement: the API goes with the page. Better
    // Auth was never handed the route, so it is 404 rather than a 403 that
    // would confirm the feature exists and is switched off.
    const posted = await page.request.post(
      app.url("/api/auth/idp/database/query"),
      { data: { query: "select 1" }, maxRedirects: 0 }
    )
    expect(posted.status()).toBe(404)
  })

  test("read-write shows the mode toggle the read-only deployment hides", async ({
    page,
    app,
    stack,
  }) => {
    test.slow()
    await reconfigure(stack, { admin: { database: "read-write" } })
    await signInAsAdmin(page, app)
    await app.goto("/admin/database")

    // Hidden under `read-only` (the mode is controlled and the fieldset is
    // `display: none`), visible here, where switching it actually does
    // something.
    await expect(page.getByRole("button", { name: "Read only" })).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Read + write" })
    ).toBeVisible()
  })
})
