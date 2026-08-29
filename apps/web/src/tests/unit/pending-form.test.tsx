import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { TextField } from "@/components/auth/form-parts"

/**
 * The server-rendered half of the pending-state pattern.
 *
 * These assertions are on the **first paint** on purpose. Everything the
 * pending state does happens after hydration, so the thing worth proving here
 * is that none of it has leaked into the document the browser gets: a form
 * that arrives already announcing itself as busy, or a submit button that
 * arrives disabled, is a form nobody can use before the JavaScript lands —
 * which is the degraded case this pattern is explicitly allowed to have (D31),
 * as long as the degradation is "no spinner" and not "no form".
 *
 * The in-flight behavior itself — the deferred frame, the submitter match,
 * the `readOnly` swap, the bfcache reset — is **not** covered anywhere. It
 * needs a real browser doing a real navigation, which neither this file nor
 * the e2e suite currently does; the e2e specs assert what the *next* page
 * says, and by then the pending state is gone with the document it lived in.
 * Said plainly rather than left implied, because "there are tests" is what
 * this comment would otherwise be taken to mean.
 */

function render(node: React.ReactNode) {
  return renderToString(<>{node}</>)
}

describe("PendingForm, before hydration", () => {
  it("is an ordinary form that would post on its own", () => {
    const html = render(
      <PendingForm busy="Working…" method="post" action="/logout">
        <SubmitButton>Sign out</SubmitButton>
      </PendingForm>
    )
    expect(html).toContain('method="post"')
    expect(html).toContain('action="/logout"')
    expect(html).toContain('type="submit"')
  })

  it("does not arrive busy, disabled, or spinning", () => {
    const html = render(
      <PendingForm busy="Working…" method="post">
        <SubmitButton>Save</SubmitButton>
      </PendingForm>
    )
    expect(html).not.toContain("aria-busy")
    expect(html).not.toContain("data-pending")
    // The attribute, not the `disabled:` Tailwind variants in the class list.
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain("animate-spin")
    // The live region exists from the first paint and is empty: a region that
    // is inserted at the same moment its text appears is not reliably read.
    expect(html).toContain('role="status"')
  })

  it("keeps a submitter's name and value, which the decision travels in", () => {
    // `/consent` posts `decision=allow|deny` from the button itself. If this
    // ever renders without them, every approval becomes a request with no
    // decision in it.
    const html = render(
      <PendingForm busy="Working…" method="post">
        <SubmitButton name="decision" value="allow">
          Allow
        </SubmitButton>
      </PendingForm>
    )
    expect(html).toContain('name="decision"')
    expect(html).toContain('value="allow"')
  })

  it("still renders a caller's own disabled as a native attribute", () => {
    // "You cannot suspend yourself" is a property of the control, not a
    // transient state, and `toBeDisabled()` in the e2e suite asserts it.
    const html = render(
      <PendingForm busy="Working…" method="post">
        <SubmitButton disabled>Suspend</SubmitButton>
      </PendingForm>
    )
    expect(html).toContain('disabled=""')
  })

  it("leaves the fields writable", () => {
    const html = render(
      <PendingForm busy="Working…" method="post">
        <TextField name="email" label="E-mail address" />
      </PendingForm>
    )
    expect(html).not.toContain("readonly")
  })
})

describe("SubmitButton outside a PendingForm", () => {
  it("is an ordinary submit button, so it is safe anywhere", () => {
    const html = render(<SubmitButton>Save</SubmitButton>)
    expect(html).toContain('type="submit"')
    expect(html).not.toContain('disabled=""')
  })
})
