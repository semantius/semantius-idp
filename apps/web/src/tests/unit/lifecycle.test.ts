/**
 * The order of a graceful shutdown (OPS-4).
 *
 * Ordering is the entire content of a drain, and it fails silently: get it
 * wrong and the process still exits 0, still logs "stopped", and the only
 * symptom is a handful of 500s in whatever was mid-request during a rollout —
 * attributed, weeks later, to the network.
 *
 * There is a second reason to test it here rather than by signalling a
 * process. **Windows cannot deliver SIGTERM to a handler at all**: `uv_kill`
 * maps it to `TerminateProcess`, so on the machine this is developed on the
 * real path can never run. Only TST-8's containerised smoke test will exercise
 * it end to end, and until that exists this is the only thing standing between
 * the sequence and a silent regression.
 */

import { describe, expect, it, vi } from "vitest"

import {
  beginDraining,
  isDraining,
  resetLifecycle,
  runDrain,
} from "@/server/http/lifecycle"

/** Records the order the steps ran in, with fake timers under our control. */
function harness(options: { stopAccepting?: () => Promise<void> } = {}) {
  const order: string[] = []
  let fire: (() => void) | undefined
  let cleared = false

  const steps = {
    beginDraining: (): void => {
      order.push("beginDraining")
    },
    stopAccepting:
      options.stopAccepting ??
      (() => {
        order.push("stopAccepting")
        return Promise.resolve()
      }),
    forceClose: (): void => {
      order.push("forceClose")
    },
    release: () => {
      order.push("release")
      return Promise.resolve()
    },
    timeoutMs: 10_000,
    timers: {
      set: (fn: () => void) => {
        fire = fn
        return "handle"
      },
      clear: () => {
        cleared = true
      },
    },
  }

  return {
    steps,
    order,
    /** Spend the grace period. */
    expire: () => fire?.(),
    wasCleared: () => cleared,
  }
}

describe("runDrain", () => {
  it("says not-ready before it stops accepting, and releases last", async () => {
    const h = harness()

    await runDrain(h.steps)

    expect(h.order).toEqual(["beginDraining", "stopAccepting", "release"])
  })

  it("does not release while requests are still in flight", async () => {
    let finish: (() => void) | undefined
    const inFlight = new Promise<void>((resolve) => {
      finish = resolve
    })
    const h = harness({ stopAccepting: () => inFlight })

    const drained = runDrain(h.steps)
    await Promise.resolve()

    // The pool is still open: something is using it.
    expect(h.order).toEqual(["beginDraining"])

    finish!()
    await drained
    expect(h.order).toEqual(["beginDraining", "release"])
  })

  it("clears its deadline when the drain finishes early", async () => {
    const h = harness()

    await runDrain(h.steps)

    expect(h.wasCleared()).toBe(true)
    expect(h.order).not.toContain("forceClose")
  })

  it("force-closes when the grace period is spent", async () => {
    let finish: (() => void) | undefined
    const h = harness({
      stopAccepting: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })

    const drained = runDrain(h.steps)
    await Promise.resolve()
    h.expire()

    expect(h.order).toEqual(["beginDraining", "forceClose"])

    finish!()
    await drained
    expect(h.order).toEqual(["beginDraining", "forceClose", "release"])
  })

  it("still releases when the wait itself fails", async () => {
    const h = harness({
      stopAccepting: () => Promise.reject(new Error("socket gone")),
    })

    await expect(runDrain(h.steps)).rejects.toThrow("socket gone")

    // A failed stop must not leave the process holding connections it will
    // never use again.
    expect(h.order).toEqual(["beginDraining", "release"])
    expect(h.wasCleared()).toBe(true)
  })
})

describe("the draining flag", () => {
  it("is what /readyz reads, and only a drain sets it", () => {
    resetLifecycle()
    expect(isDraining()).toBe(false)

    beginDraining()
    expect(isDraining()).toBe(true)

    // Idempotent: a second signal must not restart anything.
    beginDraining()
    expect(isDraining()).toBe(true)

    resetLifecycle()
  })

  it("is set by runDrain before anything else happens", async () => {
    resetLifecycle()
    const seen: boolean[] = []
    const h = harness({
      stopAccepting: () => {
        seen.push(isDraining())
        return Promise.resolve()
      },
    })
    h.steps.beginDraining = beginDraining

    await runDrain(h.steps)

    expect(seen).toEqual([true])
    resetLifecycle()
  })
})

describe("releaseResources", () => {
  // Thirty seconds, and not because the assertion is slow: `@/server/runtime`
  // pulls Better Auth, its whole plugin graph and Drizzle through vitest's
  // transform, which is seconds of work before the first line of the test runs.
  // The default 5 s made it pass or fail depending on how warm the module cache
  // happened to be — a flake, not a signal.
  it("does not build a runtime in order to close one", { timeout: 30_000 }, async () => {
    // Closing what was never opened would run the whole OPS-2 sequence —
    // migrations, key seeding, client reconciliation — on the way out of a
    // process that never served a request.
    const runtime = await import("@/server/runtime")
    const spy = vi.spyOn(runtime, "buildRuntime")

    const { releaseResources } = await import("@/server/http/lifecycle")
    await releaseResources()

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
