import { describe, expect, it } from "vitest"

import {
  deviceRefusalFor,
  normalizedUserCode,
} from "@/server/http/device-decision"

describe("deviceRefusalFor", () => {
  it("names the plugin's refusals in the page's terms", () => {
    expect(deviceRefusalFor(429, {})).toBe("tooMany")
    // Bound to another user, or an impersonating administrator: both are
    // "not the account this code is for".
    expect(deviceRefusalFor(403, { error: "access_denied" })).toBe("otherAccount")
    expect(deviceRefusalFor(403, { code: "IMPERSONATED_SESSION" })).toBe(
      "otherAccount"
    )
    expect(deviceRefusalFor(400, { error: "expired_token" })).toBe("expired")
    expect(deviceRefusalFor(400, { error: "invalid_request" })).toBe("used")
    expect(deviceRefusalFor(400, {})).toBe("invalid")
  })
})

describe("normalizedUserCode", () => {
  it("is what the plugin stores for a code as a person types it", () => {
    expect(normalizedUserCode("abcd-efgh")).toBe("ABCDEFGH")
    expect(normalizedUserCode(" ABCD EFGH ")).toBe("ABCDEFGH")
  })
})
