import { useEffect, useRef } from "react"

import { toast } from "@workspace/ui/components/toast"

import { hrefWithoutParam } from "@/lib/search-params"

/**
 * How long a confirmation stays on screen.
 *
 * Ten seconds, not the library's five: Playwright's default `expect` window is
 * ten, so a shorter toast would make an e2e assertion a race against the
 * dismissal animation rather than a test of the message.
 */
const LIFETIME_MS = 10_000

/**
 * When the wall-clock backstop below gives up waiting for Base UI's own timer.
 *
 * Two seconds of slack, so in the ordinary case — a focused window — the
 * library's timer always fires first and the backstop finds nothing to close.
 * It exists for the case where that timer is frozen.
 */
const BACKSTOP_MS = LIFETIME_MS + 2_000

/** How often the backstop re-checks while someone is reading the toast. */
const BACKSTOP_RETRY_MS = 1_000

/**
 * The query parameter that carries a one-shot handle to the notice's subject
 * (**D78**).
 *
 * A handle rather than the address itself: `safeUrlForLog` keeps the query
 * string of every path that is not `/oauth2/*` or `/api/auth/*`, so
 * `?subject=jane@example.com` would write one deleted account's address into
 * the request log on every admin action — a personal identifier in a log the
 * same codebase anonymizes IP addresses for (SEC-5). The stash is
 * `server/http/one-shot.ts`, the same one the client secret and the
 * set-password link use.
 */
export const SUBJECT_PARAM = "subject"

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
 * Five mechanics, each load-bearing:
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
 * 4. **The subject is the toast's description, not part of the sentence**
 *    (**D78**). "The account has been deleted." does not say *which* account,
 *    and an administrator working through a list of them has no way to check
 *    afterwards — the row is gone. Putting the address in the catalog sentence
 *    instead would mean a second wording for every notice and a translator
 *    deciding where a proper noun goes in it; a description line needs
 *    neither, because an e-mail address is the same in every language.
 *
 * 5. **A wall-clock backstop closes the toast even when Base UI's timer is
 *    frozen** (**D78**). The library pauses every running timer when the
 *    *window* loses focus and only resumes them when it comes back — so a
 *    confirmation left behind a switched-away window is pinned to the corner
 *    of the screen for as long as the absence lasts, which is minutes or hours
 *    and is exactly the outliving-its-truth that D71 set out to end. The
 *    backstop is deliberately *not* a replacement for the library's timer:
 *    that one still runs, still pauses on hover and on keyboard focus, and
 *    still wins whenever it is running. This only steps in when it is not.
 *
 * Rendering nothing on the server is the point: the toast is a client-side
 * affordance, which D31 permits, and a first paint that contains the
 * confirmation *and* then animates a second copy of it is worse than either.
 */
export function NoticeToast({
  message,
  subject,
  param = "notice",
}: {
  /** The already-resolved catalog sentence, or `undefined` for "no notice". */
  message: string | undefined
  /**
   * Who the notice is about — an e-mail address, shown beneath the sentence
   * (**D78**). Absent where a notice is not about one account.
   */
  subject?: string
  /** The query parameter to strip; `rotated` on `/admin/system`. */
  param?: string
}) {
  const shown = useRef(false)

  useEffect(() => {
    if (!message || shown.current) return
    shown.current = true

    const id = toast.add({
      title: message,
      description: subject,
      timeout: LIFETIME_MS,
    })

    // `data-expanded` is Base UI's own answer to "is somebody hovering this or
    // keyboard-focused inside it", and it is the one state the backstop must
    // respect: snatching a toast out from under the cursor, or away from a
    // keyboard user on their way to its close button, is the pause WCAG 2.2.1
    // asks for and the reason the library has one. Nothing else pauses it.
    const closeUnlessBeingRead = () => {
      if (document.querySelector('[data-slot="toast"][data-expanded]')) {
        window.setTimeout(closeUnlessBeingRead, BACKSTOP_RETRY_MS)
        return
      }
      // A no-op for an id the store has already removed, which is the common
      // case: the library's own timer normally gets there first.
      toast.close(id)
    }
    // Not cleared on unmount, deliberately. The toast lives in the root's
    // `<Toaster>` and outlives this component by design — a client-side
    // navigation away from the page unmounts the notice and leaves the
    // confirmation on screen, and cancelling the backstop there would restore
    // the very defect it exists for.
    window.setTimeout(closeUnlessBeingRead, BACKSTOP_MS)

    window.history.replaceState(
      window.history.state,
      "",
      // Both, and in this order: the subject travelled as a spent one-shot
      // handle on the pages that could not read it from their own loader, and
      // leaving it behind would make the address bar carry a handle to
      // nothing. Pages without one are unaffected — the second call finds no
      // such parameter and hands the string straight back.
      hrefWithoutParam(
        hrefWithoutParam(window.location.href, param),
        SUBJECT_PARAM
      )
    )
  }, [message, subject, param])

  return null
}
