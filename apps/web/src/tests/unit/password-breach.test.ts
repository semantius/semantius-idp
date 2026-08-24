/**
 * The breach check (FR-AUTH-1, SEC-8).
 *
 * Two things are being pinned down. First, that **the password does not leave
 * the process** — the request must carry five hex characters and nothing else,
 * which is the entire basis on which this feature is defensible. Second, that
 * **a failure never blocks a password**: the check is hardening, and a
 * deployment where nobody can register because a third party is down is a
 * worse outcome than a weak password getting through.
 */

import { describe, expect, it, vi } from "vitest"

import { createHash } from "node:crypto"

import { checkPasswordBreach } from "@/server/auth/password-breach"

const PASSWORD = "correct-horse-battery-staple"

function digestOf(password: string): { prefix: string; suffix: string } {
  const digest = createHash("sha1")
    .update(password, "utf8")
    .digest("hex")
    .toUpperCase()
  return { prefix: digest.slice(0, 5), suffix: digest.slice(5) }
}

function respondWith(body: string, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(body, { status })
  })
  return { fetchImpl, calls }
}

describe("what is sent", () => {
  it("sends five hex characters and nothing else", async () => {
    const { prefix } = digestOf(PASSWORD)
    const { fetchImpl, calls } = respondWith("")

    await checkPasswordBreach(PASSWORD, { fetchImpl })

    expect(calls[0]?.url).toBe(`https://api.pwnedpasswords.com/range/${prefix}`)
    // The whole argument for this feature: nothing recoverable travels.
    expect(calls[0]?.url).not.toContain(PASSWORD)
    expect(calls[0]?.url.split("/range/")[1]).toHaveLength(5)
    expect(calls[0]?.init?.body).toBeUndefined()
  })

  it("asks for padding, so the response size says nothing either", async () => {
    const { fetchImpl, calls } = respondWith("")
    await checkPasswordBreach(PASSWORD, { fetchImpl })
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get("Add-Padding")).toBe("true")
  })
})

describe("reading the answer", () => {
  it("finds the suffix and reports it breached", async () => {
    const { suffix } = digestOf(PASSWORD)
    const { fetchImpl } = respondWith(
      `0000000000000000000000000000000000A:12\r\n${suffix}:4213\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1`
    )

    const result = await checkPasswordBreach(PASSWORD, { fetchImpl })
    expect(result.breached).toBe(true)
    expect(result.count).toBe(4213)
  })

  it("is case-insensitive about the suffix", async () => {
    const { suffix } = digestOf(PASSWORD)
    const { fetchImpl } = respondWith(`${suffix.toLowerCase()}:9`)
    await expect(
      checkPasswordBreach(PASSWORD, { fetchImpl })
    ).resolves.toMatchObject({ breached: true })
  })

  it("treats a zero count as padding, not as a hit", async () => {
    // The padded response includes decoy hashes with a count of zero. Reading
    // one as a hit would refuse a perfectly good password roughly at random.
    const { suffix } = digestOf(PASSWORD)
    const { fetchImpl } = respondWith(`${suffix}:0`)
    await expect(checkPasswordBreach(PASSWORD, { fetchImpl })).resolves.toEqual(
      { breached: false }
    )
  })

  it("passes a password whose suffix is not in the range", async () => {
    const { fetchImpl } = respondWith(
      "0000000000000000000000000000000000A:12\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1"
    )
    await expect(checkPasswordBreach(PASSWORD, { fetchImpl })).resolves.toEqual(
      { breached: false }
    )
  })

  it("survives a response that is not the expected shape", async () => {
    for (const body of ["", "garbage", "no-colon-here", ":::"]) {
      const { fetchImpl } = respondWith(body)
      await expect(
        checkPasswordBreach(PASSWORD, { fetchImpl }),
        body
      ).resolves.toEqual({ breached: false })
    }
  })
})

describe("when the service is not available", () => {
  it("allows the password on a non-200", async () => {
    const { fetchImpl } = respondWith("", 503)
    await expect(checkPasswordBreach(PASSWORD, { fetchImpl })).resolves.toEqual(
      { breached: false, unavailable: true }
    )
  })

  it("allows the password when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND")
    })
    await expect(checkPasswordBreach(PASSWORD, { fetchImpl })).resolves.toEqual(
      { breached: false, unavailable: true }
    )
  })

  it("gives up rather than holding a form submission open", async () => {
    // The abort is the point: a hung upstream must not become a hung sign-up.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        })
    )
    const result = await checkPasswordBreach(PASSWORD, {
      fetchImpl,
      timeoutMs: 5,
    })
    expect(result).toEqual({ breached: false, unavailable: true })
  })

  it("logs the failure rather than swallowing it", async () => {
    const warn = vi.fn()
    const { fetchImpl } = respondWith("", 500)
    await checkPasswordBreach(PASSWORD, {
      fetchImpl,
      logger: { warn } as never,
    })
    expect(warn).toHaveBeenCalled()
  })
})

describe("the empty password", () => {
  it("is not sent anywhere", async () => {
    const { fetchImpl, calls } = respondWith("")
    await expect(checkPasswordBreach("", { fetchImpl })).resolves.toEqual({
      breached: false,
    })
    // The length validator refuses it a moment later; there is no reason to
    // spend a network round trip finding out that "" is common.
    expect(calls).toHaveLength(0)
  })
})
