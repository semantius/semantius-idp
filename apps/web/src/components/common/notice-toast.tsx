import { useEffect, useRef } from "react"

import { toast } from "@workspace/ui/components/toast"

import { hrefWithoutParam } from "@/lib/search-params"

/**
 * A one-shot success confirmation, shown as a toast and then forgotten
 * (**D71**).
 *
 * Every mutation here is a real form post followed by a 303, so the
 * confirmation has to survive a navigation — it arrives as `?notice=<code>`
 * and the landing loader turns the code into a sentence. That part is right.
 * What was wrong is that the sentence was then rendered as an inline banner
 * and **nothing ever removed the parameter**, so the URL went on claiming the
 * thing had just happened: a reload re-announced it, Back re-announced it, and
 * a bookmarked `/admin/users?notice=deleted` announced a deletion from last
 * week. The banner outlived its truth because the URL did.
 *
 * So the notice is consumed, in the strict sense: shown once, then stripped
 * from the address bar. Errors are deliberately **not** treated this way — an
 * error stays inline, beside the form that caused it, where it can be read at
 * leisure and where the draft it came back with is.
 *
 * Three mechanics, each load-bearing:
 *
 * 1. **`history.replaceState`, not `router.navigate({ replace: true })`.** A
 *    navigation re-runs the loaders — an RPC round trip to edit a query string
 *    — and, worse, re-claims the one-shot handles a `?created=` or `?draft=`
 *    sibling on the same URL has already spent. This edits the address bar and
 *    nothing else.
 *
 * 2. **`history.state` is passed straight through.** TanStack Router keeps its
 *    own keys in there; replacing the entry with `null` state detaches the
 *    current match from the router's history index and the next Back goes
 *    somewhere nobody asked for.
 *
 * 3. **The mount effect runs once, guarded by a ref.** React 18's development
 *    double-invoke would otherwise add the toast twice, and the second `add`
 *    happens after the parameter is already gone, so nothing later cancels it.
 *
 * Rendering nothing on the server is the point: the toast is a client-side
 * affordance, which D31 permits, and a first paint that contains the
 * confirmation *and* then animates a second copy of it is worse than either.
 */
export function NoticeToast({
  message,
  param = "notice",
}: {
  /** The already-resolved catalog sentence, or `undefined` for "no notice". */
  message: string | undefined
  /** The query parameter to strip; `rotated` on `/admin/system`. */
  param?: string
}) {
  const shown = useRef(false)

  useEffect(() => {
    if (!message || shown.current) return
    shown.current = true

    // Ten seconds, not the library's five: Playwright's default `expect`
    // window is ten, so a shorter toast would make an e2e assertion a race
    // against the dismissal animation rather than a test of the message.
    toast.add({ title: message, timeout: 10_000 })

    window.history.replaceState(
      window.history.state,
      "",
      hrefWithoutParam(window.location.href, param)
    )
  }, [message, param])

  return null
}
