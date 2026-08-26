import { describe, expect, it } from "vitest"

import { parseInviteLink } from "@/lib/invite-link"

/**
 * The one-time set-password link's stash shape (**D65**).
 *
 * It became `{url, email}` so the dialog can say whose account it is for. The
 * bare-URL case is kept on purpose: a handle stashed by an older process is
 * still claimable for its ten minutes across a restart, and a link that works
 * but is unlabelled is a better answer than no link at all.
 */
describe("parseInviteLink", () => {
  it("reads the labelled shape", () => {
    expect(
      parseInviteLink('{"url":"https://idp/reset?token=x","email":"a@b.test"}')
    ).toEqual({ url: "https://idp/reset?token=x", email: "a@b.test" })
  })

  it("still accepts a bare URL", () => {
    expect(parseInviteLink("https://idp/reset?token=x")).toEqual({
      url: "https://idp/reset?token=x",
    })
  })

  it("answers undefined for nothing, and for a shape it cannot use", () => {
    expect(parseInviteLink(null)).toBeUndefined()
    expect(parseInviteLink("")).toBeUndefined()
    expect(parseInviteLink("{not json")).toBeUndefined()
    expect(parseInviteLink('{"email":"a@b.test"}')).toBeUndefined()
  })

  it("drops a non-string e-mail rather than the whole link", () => {
    expect(parseInviteLink('{"url":"https://idp/x","email":42}')).toEqual({
      url: "https://idp/x",
    })
  })
})
