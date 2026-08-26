import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { LocalTime } from "@/components/common/local-time"

/**
 * The server half of `LocalTime` (FR-I18N-1).
 *
 * What matters here is that the *first paint* is deterministic. If this render
 * ever called `Intl`, the string would depend on the server's ICU data,
 * timezone and locale, and would differ from what the browser produces for the
 * same node — which is a hydration tear on every page with a timestamp on it.
 */

const ISO = "2026-08-25T21:07:33.000Z"

describe("LocalTime, server-rendered", () => {
  it("keeps the machine-readable value in the element, not only the text", () => {
    const html = renderToString(<LocalTime iso={ISO} />)
    // React emits the JSX spelling; HTML attribute names are case-insensitive.
    expect(html).toContain(`dateTime="${ISO}"`)
    expect(html).toContain(`title="${ISO}"`)
  })

  it("renders UTC, and says so, before hydration", () => {
    // Labelled: an unlabelled 21:07 that is really 23:07 in Berlin is worse
    // than no time at all, and this string is what a no-JS reader keeps.
    expect(renderToString(<LocalTime iso={ISO} />)).toContain(
      "2026-08-25 21:07 UTC"
    )
  })

  it("drops the time entirely for the date variant", () => {
    const html = renderToString(<LocalTime iso={ISO} variant="date" />)
    expect(html).toContain(">2026-08-25<")
    expect(html).not.toContain("UTC")
  })

  it("renders the same string every time, whatever the host locale is", () => {
    // The regression this guards is subtle: an `Intl` call here passes locally
    // and tears in production, where the container's ICU and TZ differ.
    const first = renderToString(<LocalTime iso={ISO} />)
    const second = renderToString(<LocalTime iso={ISO} />)
    expect(first).toBe(second)
  })

  it("shows an unparseable value rather than `Invalid Date`", () => {
    expect(renderToString(<LocalTime iso="not a date" />)).toContain(
      "not a date"
    )
  })
})
