import { useEffect, useRef } from "react"

import { hrefWithoutParam } from "@/lib/search-params"

/**
 * Takes parameters the loader has already consumed out of the address bar
 * (**D93**).
 *
 * `claimAdminDraft` is **single-use** (`server/http/draft.ts`), and nothing
 * stripped `?error=` and `?draft=` after it. So reloading a refused form — the
 * state where a reload is most tempting, because the page looks like it did
 * nothing — rendered twelve *empty* fields under a live error message about
 * values that no longer exist anywhere. That is the defect **D71** diagnosed
 * for `?notice=`, on the parameters D71 deliberately left alone: an error
 * beside its restored draft is right, and an error beside a draft that has
 * been spent is not.
 *
 * The mechanism is D71's, and its first two mechanics are the reason it is
 * `history.replaceState` rather than a navigation. Read `notice-toast.tsx`
 * before changing this:
 *
 * 1. **`router.navigate` would re-run the loaders**, which would re-claim the
 *    one-shot handles a sibling parameter on the same URL has already spent.
 * 2. **`history.state` is passed straight through**, because TanStack Router
 *    keeps its own keys in there and a `null` state detaches the current match
 *    from the history index.
 * 3. The effect runs once, guarded by a ref, so React's development
 *    double-invoke cannot fight itself over the address bar.
 */
export function ClaimedParams({ names }: { names: readonly string[] }) {
  const done = useRef(false)

  useEffect(() => {
    if (done.current) return
    done.current = true
    const stripped = names.reduce(
      (href, name) => hrefWithoutParam(href, name),
      window.location.href
    )
    // `hrefWithoutParam` hands the string back unchanged when the parameter is
    // not there, so this is a no-op on the ordinary first visit — and a
    // `replaceState` that changes nothing still pushes a history entry's worth
    // of work at every page in the area.
    if (stripped === window.location.href) return
    window.history.replaceState(window.history.state, "", stripped)
  }, [names])

  return null
}
