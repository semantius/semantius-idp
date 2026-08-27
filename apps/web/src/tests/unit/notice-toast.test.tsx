import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { NoticeToast } from "@/components/common/notice-toast"

/**
 * The first paint, which is the only half of this component a node-environment
 * test can see (**D71**).
 *
 * `NoticeToast` is deliberately client-only: it renders nothing on the server
 * and does all of its work — adding the toast, then stripping the parameter
 * from the address bar — in a mount effect. D31 allows that, because a success
 * confirmation is not something the page needs before JavaScript arrives; what
 * would not be allowed is the *first paint* containing the sentence, because
 * then the toast that follows is a second copy of it.
 *
 * So this asserts the absence, on the `pending-form.test.tsx` pattern. The
 * behaviour that matters — the toast appears, the URL loses `?notice=`, a
 * reload does not bring it back — is driven by a browser in
 * `e2e/account.spec.ts`, because none of it exists until hydration.
 */
function render(node: React.ReactNode) {
  return renderToString(<>{node}</>)
}

describe("NoticeToast, before hydration", () => {
  it("puts nothing in the document, message or not", () => {
    expect(render(<NoticeToast message="Profile updated." />)).toBe("")
    expect(render(<NoticeToast message={undefined} />)).toBe("")
  })

  it("never server-renders the sentence itself", () => {
    // The regression this guards: a "helpful" fallback that renders the
    // message inline for the pre-hydration case would put it on screen twice
    // — once as text, once as the toast that follows a moment later.
    const html = render(
      <NoticeToast message="The account has been created." param="notice" />
    )
    expect(html).not.toContain("The account has been created.")
  })
})
