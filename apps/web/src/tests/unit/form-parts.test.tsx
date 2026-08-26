import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PasswordField } from "@/components/auth/form-parts"

/**
 * R-1: the reveal control is an icon button inside the field, not a pair of
 * underlined links below it.
 *
 * These assertions are on the **server-rendered** markup on purpose. The whole
 * point of the checkbox mechanism is that the control is already correct on the
 * first paint, before any JavaScript runs (FR-ACCT-2), so that is where it has
 * to be provable. The visual side — that the label really sits inside the
 * field — is Tailwind's job and M13's axe run re-checks the a11y outcome.
 */

function render(overrides: Partial<Parameters<typeof PasswordField>[0]> = {}) {
  return renderToString(
    <PasswordField
      name="password"
      label="Password"
      autoComplete="current-password"
      showLabel="Show password"
      hideLabel="Hide password"
      {...overrides}
    />
  )
}

describe("PasswordField reveal control", () => {
  it("renders exactly one control bound to the reveal checkbox", () => {
    const html = render()
    // The id is generated rather than the field name, so the assertion is
    // that the label and the checkbox agree — not on what the id says. Three
    // fields on `/account/security` are called `password`, and an id taken
    // from the name pointed all three labels at the first one.
    const forAttr = /for="(password-[^"]*-reveal)"/.exec(html)
    expect(forAttr, "a label bound to the reveal checkbox").toBeTruthy()
    expect(html.match(/for="password-[^"]*-reveal"/g)).toHaveLength(1)
    expect(html).toContain(`id="${forAttr![1]}"`)
    expect(html).toContain('type="checkbox"')
  })

  it("gives two fields of the same name different ids", () => {
    // The bug this closes: `<label for>` resolves to the first matching id in
    // the *document*, so the change-password dialog's `password` field and the
    // second-factor form's `password` field named the same control.
    //
    // Rendered as one tree on purpose — `useId` is unique within a render, and
    // "one page" is one render. Two separate `renderToString` calls would each
    // start counting again, which is not a case that exists here.
    const html = renderToString(
      <>
        <PasswordField
          name="password"
          label="New password"
          autoComplete="new-password"
          showLabel="Show password"
          hideLabel="Hide password"
        />
        <PasswordField
          name="password"
          label="Current password"
          autoComplete="current-password"
          showLabel="Show password"
          hideLabel="Hide password"
        />
      </>
    )
    const ids = html.match(/id="password-[^"]*"/g) ?? []
    expect(ids.length).toBeGreaterThan(1)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("names the checkbox for both states, so the name changes with it", () => {
    const html = render()
    // Both names ship in the markup; CSS shows whichever matches the state.
    expect(html).toContain("Show password")
    expect(html).toContain("Hide password")
    expect(html.match(/class="sr-only[^"]*"/g) ?? []).toHaveLength(2)
  })

  it("ships both icons, hidden from assistive technology", () => {
    const html = render()
    expect(html.match(/<svg/g) ?? []).toHaveLength(2)
    expect(html.match(/aria-hidden="true"/g) ?? []).toHaveLength(2)
  })

  it("masks the field in the server-rendered output", () => {
    // A field that arrives as `type="text"` and is corrected by script would
    // flash the password on a slow hydrate.
    expect(render()).toContain('type="password"')
  })

  it("no longer renders the underlined links that R-1 rejected", () => {
    const html = render()
    expect(html).not.toContain("underline")
    // `w-fit` was what made each link a block of its own under the input.
    expect(html).not.toContain("w-fit")
  })

  it("leaves room for the control and keeps Firefox's CSS fallback", () => {
    const html = render()
    expect(html).toContain("pr-10")
    expect(html).toContain("group-has-checked:[-webkit-text-security:none]")
  })

  it("withdraws the control when scripting is off, rather than lying", () => {
    // Scripting-off is not a supported case (D31), but this costs nothing and
    // Blink and WebKit clamp a password field back to `disc` whatever the
    // style says — so without script the toggle would rename itself "Hide
    // password" over a still-masked field. Both halves carry the hook.
    const html = render()
    expect(html).toContain("<noscript>")
    expect(html).toContain("[data-idp-reveal]{display:none}")
    expect(html.match(/data-idp-reveal=""/g) ?? []).toHaveLength(2)
  })

  it("still wires hint, error and describedby the same way", () => {
    const html = render({ hint: "At least 12 characters", error: "Too short" })
    const described = /aria-describedby="(password-[^"]*-hint) (password-[^"]*-error)"/.exec(
      html
    )
    expect(described, "both ids in aria-describedby").toBeTruthy()
    expect(html).toContain(`id="${described![1]}"`)
    expect(html).toContain(`id="${described![2]}"`)
    expect(html).toContain('aria-invalid="true"')
  })
})
