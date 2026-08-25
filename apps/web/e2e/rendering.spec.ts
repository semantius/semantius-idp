import { expect, test } from "./fixtures"

/**
 * The gate that did not exist when the sign-in page lost its stylesheet
 * (TST-6).
 *
 * For four milestones every page in `vite dev` arrived with no stylesheet, no
 * client entry and no hot reload, and the whole board stayed green — because
 * every gate in this repository read HTML, and the HTML was perfect. The site
 * name was there, the layout was there, every Tailwind class name was there.
 * Only the paint was missing.
 *
 * `dev-server.test.ts` closed the specific hole (it fetches the stylesheet from
 * a real Vite dev server). This closes the general one: it opens the page in a
 * browser and asks whether it is *painted*, which is the question no assertion
 * about markup can answer.
 *
 * The assertions are deliberately about **computed style and layout**, not
 * about screenshots. A pixel baseline would fail on every font-rendering
 * difference between a developer's machine and CI, get updated without being
 * read, and stop meaning anything by the third time. These fail only when the
 * page genuinely is not styled.
 */

test.describe("the sign-in page is actually rendered", () => {
  test("arrives with its stylesheet applied", async ({ page, app, stack }) => {
    const failed: string[] = []
    page.on("requestfailed", (request) =>
      failed.push(`${request.method()} ${request.url()}`)
    )
    const notOk: string[] = []
    page.on("response", (response) => {
      if (response.status() >= 400) {
        notOk.push(`${response.status()} ${response.url()}`)
      }
    })

    await app.goto("/login")

    // 1. Nothing the page asked for is missing. This alone is what a 404 on
    //    the stylesheet would have tripped.
    expect(failed, "requests that failed outright").toEqual([])
    expect(notOk, "sub-resources that answered 4xx/5xx").toEqual([])

    // 2. A stylesheet is present *and the browser parsed rules out of it*. A
    //    <link> that 404s still appears in `document.styleSheets` with zero
    //    rules, so counting sheets is not enough — counting rules is.
    //
    //    The threshold is deliberately far below what the page actually loads.
    //    Tailwind emits only the utilities in use and Vite splits the result
    //    across chunks, so the exact count moves whenever a class is added
    //    anywhere in the application — it once dropped from 103 to 87 and
    //    failed a gate that had nothing to say about the change. Zero versus
    //    not-zero is the real signal; the substance is the computed style
    //    below.
    const rules = await page.evaluate(() =>
      [...document.styleSheets].reduce((total, sheet) => {
        try {
          return total + sheet.cssRules.length
        } catch {
          return total
        }
      }, 0)
    )
    expect(rules, "CSS rules the browser parsed").toBeGreaterThan(20)

    // 3. The card is laid out. Tailwind's `max-w-sm` and the centring on the
    //    shell are the two properties that would be gone with no stylesheet —
    //    an unstyled <div> is full-bleed and its parent is not a flex column.
    const shell = page.locator("main").first()
    await expect(shell).toHaveCSS("display", "flex")
    await expect(shell).toHaveCSS("flex-direction", "column")

    const heading = page.getByRole("heading", { name: /sign in/i })
    await expect(heading).toBeVisible()
    // An unstyled <h1> is bold and roughly 32px; the design makes it smaller.
    // The exact value is not the point — that *a rule applied* is.
    const headingSize = await heading.evaluate(
      (node) => getComputedStyle(node).fontSize
    )
    expect(parseFloat(headingSize)).toBeLessThan(28)

    // 4. The e-mail field is not a bare input: it has the border and radius
    //    the component gives it.
    const email = page.getByLabel(/e-?mail/i)
    await expect(email).toBeVisible()
    await expect(email).toHaveCSS("border-radius", /[1-9]/)

    // 5. The site name from configuration is on the page — the branding half
    //    of "unbranded", as distinct from the styling half.
    await expect(page.getByText("E2E IdP").first()).toBeVisible()
    expect(await page.title()).toContain("E2E IdP")

    // 6. And the mount path did not leak: every stylesheet and script the page
    //    loaded is under this deployment's own base URL (OPS-10).
    const assets = await page.evaluate(() => [
      ...[...document.querySelectorAll("link[rel=stylesheet]")].map(
        (node) => (node as HTMLLinkElement).href
      ),
      ...[...document.querySelectorAll("script[src]")].map(
        (node) => (node as HTMLScriptElement).src
      ),
    ])
    expect(assets.length).toBeGreaterThan(0)
    for (const asset of assets) {
      expect(asset, "asset outside the deployment's base URL").toContain(
        `127.0.0.1:${stack.port}${stack.basePath}`
      )
    }
  })

  test("hydrates, so the password reveal actually toggles", async ({
    page,
    app,
  }) => {
    // A page whose client entry never loaded looks completely normal until
    // something has to *react*, which is why this asserts an interaction
    // rather than the presence of a <script> tag.
    //
    // **Driven from the keyboard, and not by clicking the checkbox.** The
    // checkbox is `sr-only`: it is the mechanism, and the eye icon painted over
    // it is the control — so a pointer click on the input is intercepted by the
    // label, exactly as it would be for a person. Tab-then-Space is what the
    // control is actually for, and it asserts the two things R-1 asked for at
    // once: that it is reachable in the natural tab order, and that the toggle
    // works.
    await app.goto("/login")

    const password = page.getByLabel("Password", { exact: true })
    await expect(password).toHaveAttribute("type", "password")

    await password.focus()
    await page.keyboard.press("Tab")

    const reveal = page.getByRole("checkbox", { name: /show password/i })
    await expect(reveal).toBeFocused()

    await page.keyboard.press("Space")
    await expect(password).toHaveAttribute("type", "text")
    // The accessible name changes with the state, so a screen reader is not
    // told to "show" a field that is already showing.
    await expect(
      page.getByRole("checkbox", { name: /hide password/i })
    ).toBeFocused()

    await page.keyboard.press("Space")
    await expect(password).toHaveAttribute("type", "password")
  })

  test("renders the error page rather than a stack trace", async ({ page, app }) => {
    const response = await app.goto("/this-route-does-not-exist")

    expect(response?.status()).toBe(404)
    await expect(page.getByText(/not found/i).first()).toBeVisible()
    // FR-ACCT-2: nothing about what does exist, and no framework internals.
    expect(await page.content()).not.toMatch(/at \w+ \(.*:\d+:\d+\)/)
  })
})
