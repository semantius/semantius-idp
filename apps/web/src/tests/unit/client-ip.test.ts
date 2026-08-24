/**
 * Which address a request came from (SEC-2, SEC-5).
 *
 * The cases that matter are the adversarial ones. `X-Forwarded-For` is a list
 * anyone can prepend to, so every test here asks the same question in a
 * different shape: *can a client make us believe an address that is not
 * theirs?* If it can, the rate limiter buckets the wrong person and the audit
 * trail records a lie.
 */

import { describe, expect, it } from "vitest"

import {
  clientIpFrom,
  inCidr,
  isTrusted,
  normalizeIp,
} from "@/server/http/client-ip"

function request(forwarded?: string, header = "x-forwarded-for"): Request {
  return new Request("https://idp.example.com/login", {
    headers: forwarded === undefined ? {} : { [header]: forwarded },
  })
}

const PRIVATE = ["10.0.0.0/8", "192.168.0.0/16"]

describe("with trustProxy off", () => {
  it("ignores the header completely", () => {
    expect(
      clientIpFrom(request("1.2.3.4"), false, { socketAddress: "203.0.113.7" })
    ).toBe("203.0.113.7")
  })

  it("has no answer when the runtime cannot supply a socket address", () => {
    // Not "0.0.0.0" and not the header: a rate limiter that invents an address
    // here puts the whole internet in one bucket.
    expect(clientIpFrom(request("1.2.3.4"), false)).toBeUndefined()
  })
})

describe("with a CIDR list", () => {
  it("takes the first hop from the right that is not a proxy of ours", () => {
    // The client claimed 9.9.9.9; our proxy appended what it saw.
    const found = clientIpFrom(request("9.9.9.9, 203.0.113.7"), PRIVATE, {
      socketAddress: "10.0.0.5",
    })
    expect(found).toBe("203.0.113.7")
  })

  it("walks past however many of our own hops there are", () => {
    const found = clientIpFrom(
      request("203.0.113.7, 10.0.0.9, 192.168.1.1"),
      PRIVATE,
      { socketAddress: "10.0.0.5" }
    )
    expect(found).toBe("203.0.113.7")
  })

  it("cannot be fooled by a client prepending a private address", () => {
    // The oldest trick: claim to be the proxy. Walking from the right means
    // the claim is simply never reached.
    const found = clientIpFrom(request("10.0.0.99, 198.51.100.4"), PRIVATE, {
      socketAddress: "10.0.0.5",
    })
    expect(found).toBe("198.51.100.4")
  })

  it("falls back to the socket address when the header is only ours", () => {
    // Nothing in the chain is a client. Misconfiguration, not a request — and
    // the answer is at least an address we control rather than a guess.
    const found = clientIpFrom(request("10.0.0.9"), PRIVATE, {
      socketAddress: "10.0.0.5",
    })
    expect(found).toBe("10.0.0.9")
  })

  it("ignores a header with nothing parseable in it", () => {
    expect(
      clientIpFrom(request("unknown, garbage"), PRIVATE, {
        socketAddress: "203.0.113.7",
      })
    ).toBe("203.0.113.7")
  })

  it("reads a differently-named header when the deployment uses one", () => {
    const found = clientIpFrom(
      request("198.51.100.4", "cf-connecting-ip"),
      PRIVATE,
      { socketAddress: "10.0.0.5", header: "cf-connecting-ip" }
    )
    expect(found).toBe("198.51.100.4")
  })
})

describe("with trustProxy true", () => {
  it("takes the leftmost entry, which is what `true` means", () => {
    expect(
      clientIpFrom(request("198.51.100.4, 10.0.0.9"), true, {
        socketAddress: "10.0.0.5",
      })
    ).toBe("198.51.100.4")
  })

  it("is therefore spoofable, which is why it is not the default", () => {
    // Stated as a test rather than only as prose: `true` is a promise that
    // nothing but the proxy can reach the port.
    expect(clientIpFrom(request("1.2.3.4"), true)).toBe("1.2.3.4")
  })
})

describe("IPv6 and the shapes addresses arrive in", () => {
  it("unwraps a v4-mapped address so CIDR checks still work", () => {
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1")
    expect(isTrusted("::ffff:10.0.0.1", PRIVATE)).toBe(false)
    expect(isTrusted(normalizeIp("::ffff:10.0.0.1")!, PRIVATE)).toBe(true)
  })

  it("strips a port, in both notations", () => {
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1")
    expect(normalizeIp("203.0.113.7:5000")).toBe("203.0.113.7")
    // A bare v6 address has many colons and no port; it must survive intact.
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1")
  })

  it("refuses things that are not addresses", () => {
    for (const value of [
      "",
      "   ",
      "unknown",
      "999.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "01.2.3.4",
      "[2001:db8::1",
      "gggg::1",
      "1::2::3",
    ]) {
      expect(normalizeIp(value), value).toBeUndefined()
    }
  })

  it("matches v6 ranges by prefix", () => {
    expect(inCidr("2001:db8::1", "2001:db8::/32")).toBe(true)
    expect(inCidr("2001:db9::1", "2001:db8::/32")).toBe(false)
    // Unique-local, the v6 equivalent of a private range.
    expect(inCidr("fd00::1", "fc00::/7")).toBe(true)
  })

  it("never matches a v4 address against a v6 range, or the reverse", () => {
    expect(inCidr("10.0.0.1", "::/0")).toBe(false)
    expect(inCidr("::1", "0.0.0.0/0")).toBe(false)
  })

  it("resolves a v6 chain the same way as a v4 one", () => {
    const found = clientIpFrom(
      request("2001:db8::99, [2001:db8::1]:443"),
      ["2001:db8::/32"],
      { socketAddress: "2001:db8::1" }
    )
    // Every hop is inside the trusted range, so there is no client in the
    // chain and the leftmost is returned.
    expect(found).toBe("2001:db8::99")
  })
})

describe("CIDR arithmetic", () => {
  it("handles prefixes that do not land on a byte boundary", () => {
    expect(inCidr("192.168.1.5", "192.168.1.0/28")).toBe(true)
    expect(inCidr("192.168.1.20", "192.168.1.0/28")).toBe(false)
    expect(inCidr("203.0.113.130", "203.0.113.128/25")).toBe(true)
    expect(inCidr("203.0.113.127", "203.0.113.128/25")).toBe(false)
  })

  it("treats a bare address as a single host", () => {
    // An operator listing one proxy means that proxy; requiring `/32` would be
    // a trap rather than a clarification.
    expect(inCidr("10.0.0.5", "10.0.0.5")).toBe(true)
    expect(inCidr("10.0.0.6", "10.0.0.5")).toBe(false)
  })

  it("matches everything at /0 and only itself at /32", () => {
    expect(inCidr("203.0.113.7", "0.0.0.0/0")).toBe(true)
    expect(inCidr("203.0.113.7", "203.0.113.7/32")).toBe(true)
    expect(inCidr("203.0.113.8", "203.0.113.7/32")).toBe(false)
  })

  it("refuses a malformed range rather than matching it", () => {
    for (const range of ["", "/8", "10.0.0.0/33", "10.0.0.0/-1", "nope/8"]) {
      expect(inCidr("10.0.0.1", range), range).toBe(false)
    }
  })
})
