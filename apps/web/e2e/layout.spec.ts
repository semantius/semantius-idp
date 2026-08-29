import { signInAsAdmin } from "./actions"
import { expect, test } from "./fixtures"

/**
 * The sidebar shell `/admin/*` and `/account/*` wear (TST-6, **D82**).
 *
 * Two properties that only a real browser can answer, and that nothing else
 * in this suite would notice if they broke:
 *
 * 1. **The collapse survives a reload, on the first paint.** The state is a
 *    cookie the browser writes and the server reads (`http/sidebar-cookie.ts`),
 *    which is the whole reason it is not `localStorage`: read after hydration,
 *    the sidebar would render open and then snap shut on every navigation.
 *    Running under the sub-path project as well is what proves the cookie's
 *    `Path` is scoped to the mount (OPS-10) rather than to `/`.
 * 2. **The mobile sheet.** Below `md` the sidebar is not merely narrow, it is
 *    a different element — the registry swaps the fixed rail for a `Sheet` —
 *    and the navigation is unreachable until the trigger opens it.
 */

/**
 * The header's toggle, and **not** `getByRole("button", { name: … })`.
 *
 * `SidebarRail` is a second visible button whose registry `aria-label` is
 * "Toggle Sidebar", which matches our catalog's "Toggle sidebar"
 * case-insensitively — so the accessible-name locator matches two elements and
 * Playwright's strict mode fails the test rather than the application.
 */
const TRIGGER = '[data-sidebar="trigger"]'
const SIDEBAR = '[data-slot="sidebar"]'

test.describe("the sidebar shell", () => {
  test("collapses, and is still collapsed after a reload (D82)", async ({
    page,
    app,
  }) => {
    await signInAsAdmin(page, app)
    await app.goto("/admin")

    const sidebar = page.locator(SIDEBAR)
    await expect(sidebar).toHaveAttribute("data-state", "expanded")
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible()

    await page.locator(TRIGGER).click()
    await expect(sidebar).toHaveAttribute("data-state", "collapsed")
    // The owner's choice: an icon rail, not a hidden navigation. The entries
    // are still there and still reachable, with the label as a tooltip.
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible()

    // The server, not the client, has to be the one that knows: assert on a
    // fresh document rather than after a client-side navigation.
    await page.reload()
    await expect(page.locator(SIDEBAR)).toHaveAttribute(
      "data-state",
      "collapsed"
    )

    // And the same cookie is read behind the account area's own layout.
    await app.goto("/account")
    await expect(page.locator(SIDEBAR)).toHaveAttribute(
      "data-state",
      "collapsed"
    )

    // Put it back, so the state this leaves behind is the default one.
    await page.locator(TRIGGER).click()
    await expect(page.locator(SIDEBAR)).toHaveAttribute(
      "data-state",
      "expanded"
    )
  })

  test("is a sheet on a narrow viewport, opened by the trigger", async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signInAsAdmin(page, app)
    await app.goto("/admin")

    // The heading is the page; the navigation is not on it yet. Since **D93**
    // that heading is the page's own name — the chrome row is the
    // breadcrumb's, and nothing renders "Administration" any more.
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Users" })).toBeHidden()

    await page.locator(TRIGGER).click()
    const drawer = page.locator(`${SIDEBAR}[data-mobile="true"]`)
    await expect(drawer).toBeVisible()

    await drawer.getByRole("link", { name: "Users" }).click()
    await expect(page).toHaveURL(new RegExp(`${app.basePath}/admin/users`))
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible()
  })
})
