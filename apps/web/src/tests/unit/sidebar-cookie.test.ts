/**
 * The sidebar's collapse state, read on the server (**D82**).
 *
 * Small, but it decides the *first paint* of every page under `/admin` and
 * `/account`: get it wrong and the sidebar renders open and then snaps shut
 * once React hydrates, on every navigation. The cases worth pinning are the
 * ones a hand-rolled cookie parse gets wrong — a name that is a suffix of
 * ours, the leading space `Cookie:` puts before every pair but the first, and
 * a value that is not one of the two we write.
 */

import { describe, expect, it } from "vitest"

import { SIDEBAR_COOKIE, readSidebarOpen } from "@/server/http/sidebar-cookie"

function withCookie(header?: string): Request {
  return new Request("http://localhost:3000/admin", {
    headers: header === undefined ? {} : { cookie: header },
  })
}

describe("readSidebarOpen", () => {
  it("defaults to open when the browser has never said otherwise", () => {
    expect(readSidebarOpen(withCookie())).toBe(true)
    expect(readSidebarOpen(withCookie(""))).toBe(true)
    expect(readSidebarOpen(withCookie("other=1"))).toBe(true)
  })

  it("reads both values it writes", () => {
    expect(readSidebarOpen(withCookie(`${SIDEBAR_COOKIE}=false`))).toBe(false)
    expect(readSidebarOpen(withCookie(`${SIDEBAR_COOKIE}=true`))).toBe(true)
  })

  it("finds the pair wherever it sits in the header", () => {
    // Every pair but the first arrives with the separator's space on it.
    expect(
      readSidebarOpen(withCookie(`a=1; ${SIDEBAR_COOKIE}=false; b=2`))
    ).toBe(false)
    expect(readSidebarOpen(withCookie(`${SIDEBAR_COOKIE}=false; b=2`))).toBe(
      false
    )
    expect(readSidebarOpen(withCookie(`a=1; ${SIDEBAR_COOKIE}=false`))).toBe(
      false
    )
  })

  it("is not fooled by a name that merely ends with ours", () => {
    // Better Auth's cookies are prefixed (`__Secure-…`), so a name that
    // contains this one is not hypothetical.
    expect(
      readSidebarOpen(withCookie(`__Secure-${SIDEBAR_COOKIE}=false`))
    ).toBe(true)
    expect(readSidebarOpen(withCookie(`${SIDEBAR_COOKIE}_x=false`))).toBe(true)
  })

  it("treats anything that is not `false` as open", () => {
    // A half-written or tampered cookie should not collapse the navigation.
    expect(readSidebarOpen(withCookie(`${SIDEBAR_COOKIE}=`))).toBe(true)
    expect(readSidebarOpen(withCookie(`${SIDEBAR_COOKIE}=FALSE`))).toBe(true)
    expect(readSidebarOpen(withCookie(`${SIDEBAR_COOKIE}=nonsense`))).toBe(true)
  })
})
