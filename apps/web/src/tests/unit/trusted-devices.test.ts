import { describe, expect, it } from "vitest"

import {
  TRUST_DEVICE_MAX_WINDOWS,
  TRUST_DEVICE_PREFIX,
  capTrustedDeviceExpiry,
  isTrustedDeviceIdentifier,
  trustedDeviceCeilingMs,
  trustedDeviceVerificationHooks,
} from "@/server/auth/trusted-devices"

/**
 * The hard ceiling on a trusted browser, asserted without a
 * database or a sign-in.
 *
 * Better Auth rotates a trust row on every use with a full expiry, so the
 * window in `twoFactor.trustDeviceDays` slides for ever — and so does a
 * cookie copied off the browser. The two database hooks under test carry the
 * first-issue time across that rotation and cap the new expiry at three
 * windows from it. What is asserted here is the arithmetic and the carry;
 * the integration file drives a real re-mint through the plugin.
 */

const DAY = 24 * 60 * 60 * 1000

function daysAgo(days: number, from = Date.now()): Date {
  return new Date(from - days * DAY)
}

function trustRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row",
    identifier: `${TRUST_DEVICE_PREFIX}abcdef`,
    value: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * DAY),
    ...overrides,
  }
}

describe("the ceiling", () => {
  it("is three windows", () => {
    expect(TRUST_DEVICE_MAX_WINDOWS).toBe(3)
    expect(trustedDeviceCeilingMs(30)).toBe(90 * DAY)
    expect(trustedDeviceCeilingMs(7)).toBe(21 * DAY)
    // "Always ask" gives a ceiling of nothing, without a cross-check.
    expect(trustedDeviceCeilingMs(0)).toBe(0)
    expect(trustedDeviceCeilingMs(-1)).toBe(0)
  })

  it("leaves a request under the ceiling alone", () => {
    const now = Date.now()
    const requested = new Date(now + 30 * DAY)
    expect(
      capTrustedDeviceExpiry({
        firstIssued: daysAgo(10, now),
        requested,
        ceilingMs: 90 * DAY,
      })
    ).toBe(requested)
  })

  it("caps a request that would outlive it", () => {
    const now = Date.now()
    const first = daysAgo(80, now)
    expect(
      capTrustedDeviceExpiry({
        firstIssued: first,
        requested: new Date(now + 30 * DAY),
        ceilingMs: 90 * DAY,
      }).getTime()
    ).toBe(first.getTime() + 90 * DAY)
  })

  it("recognizes only the plugin's own prefix", () => {
    expect(isTrustedDeviceIdentifier(`${TRUST_DEVICE_PREFIX}x`)).toBe(true)
    expect(isTrustedDeviceIdentifier("reset-password:x")).toBe(false)
    expect(isTrustedDeviceIdentifier(undefined)).toBe(false)
  })
})

describe("the hooks", () => {
  const hooks = trustedDeviceVerificationHooks(30)

  it("ignore every other verification row", async () => {
    const context = {} as never
    const reset = trustRow({ identifier: "reset-password:token" })
    expect(await hooks.delete!.before!(reset, context)).toBeUndefined()
    expect(await hooks.create!.before!(reset, context)).toBeUndefined()
  })

  it("never refuse a delete", async () => {
    // `false` from a delete hook would keep the old row alive beside the new
    // one; the hook only reads.
    expect(await hooks.delete!.before!(trustRow(), {} as never)).toBeUndefined()
  })

  it("treat a create with nothing stashed as a first issue", async () => {
    const now = Date.now()
    const fresh = trustRow({
      createdAt: new Date(now),
      expiresAt: new Date(now + 30 * DAY),
    })
    const result = (await hooks.create!.before!(fresh, {} as never)) as {
      data: { createdAt: Date; expiresAt: Date }
    }
    expect(result.data.createdAt.getTime()).toBe(now)
    expect(result.data.expiresAt.getTime()).toBe(now + 30 * DAY)
  })

  it("carry the first-issue time across a rotation and cap the new expiry", async () => {
    const now = Date.now()
    const context = {} as never
    const first = daysAgo(80, now)

    await hooks.delete!.before!(trustRow({ createdAt: first }), context)
    const result = (await hooks.create!.before!(
      trustRow({
        identifier: `${TRUST_DEVICE_PREFIX}rotated`,
        createdAt: new Date(now),
        expiresAt: new Date(now + 30 * DAY),
      }),
      context
    )) as { data: { createdAt: Date; expiresAt: Date; identifier: string } }

    // The anchor survives, the identifier is the plugin's, and the expiry is
    // ten days out rather than thirty.
    expect(result.data.createdAt).toBe(first)
    expect(result.data.identifier).toBe(`${TRUST_DEVICE_PREFIX}rotated`)
    expect(result.data.expiresAt.getTime()).toBe(first.getTime() + 90 * DAY)
  })

  it("leave a rotation past the ceiling with a row that is already dead", async () => {
    const now = Date.now()
    const context = {} as never
    const first = daysAgo(100, now)

    await hooks.delete!.before!(trustRow({ createdAt: first }), context)
    const result = (await hooks.create!.before!(
      trustRow({ createdAt: new Date(now), expiresAt: new Date(now + 30 * DAY) }),
      context
    )) as { data: { expiresAt: Date } }

    expect(result.data.expiresAt.getTime()).toBeLessThan(now)
  })

  it("keep the stash to the request it was made on", async () => {
    const now = Date.now()
    const first = daysAgo(80, now)
    await hooks.delete!.before!(trustRow({ createdAt: first }), {} as never)

    // A different request — `/two-factor/disable` deleted a row and nothing
    // followed; the next sign-in's create must not inherit its anchor.
    const result = (await hooks.create!.before!(
      trustRow({ createdAt: new Date(now), expiresAt: new Date(now + 30 * DAY) }),
      {} as never
    )) as { data: { createdAt: Date } }
    expect(result.data.createdAt.getTime()).toBe(now)
  })

  it("treat a hook with no context as a first issue", async () => {
    const now = Date.now()
    await hooks.delete!.before!(trustRow({ createdAt: daysAgo(80, now) }), null)
    const result = (await hooks.create!.before!(
      trustRow({ createdAt: new Date(now), expiresAt: new Date(now + 30 * DAY) }),
      null
    )) as { data: { createdAt: Date } }
    expect(result.data.createdAt.getTime()).toBe(now)
  })

  it("accept a stored timestamp the adapter hands back as a string", async () => {
    const now = Date.now()
    const context = {} as never
    const first = daysAgo(80, now)
    await hooks.delete!.before!(
      trustRow({ createdAt: first.toISOString() }),
      context
    )
    const result = (await hooks.create!.before!(
      trustRow({ createdAt: new Date(now), expiresAt: new Date(now + 30 * DAY) }),
      context
    )) as { data: { createdAt: Date } }
    expect(result.data.createdAt.getTime()).toBe(first.getTime())
  })
})
