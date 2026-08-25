/**
 * Graceful shutdown (OPS-4).
 *
 * A container that is being replaced gets a SIGTERM and then, some seconds
 * later, a SIGKILL. What happens in between is the whole of this module's
 * subject, and it is two separate things that are easy to conflate:
 *
 *  1. **Stop being chosen.** The moment the signal arrives, `/readyz` must say
 *     not-ready, so the load balancer takes this instance out of rotation. It
 *     is still serving — it just should not be given anything new.
 *  2. **Stop holding.** Once the in-flight requests have finished, the
 *     database pool can be closed and the process can exit 0.
 *
 * Doing (2) at the moment the signal arrives is the mistake this module exists
 * to prevent: closing the pool under a request that is halfway through issuing
 * a token turns an orderly rollout into a handful of 500s.
 *
 * `/healthz` deliberately keeps answering 200 throughout. Liveness asks
 * "should this container be killed and restarted", and a container that is
 * draining on purpose should not be — that is what readiness is for (OPS-3).
 *
 * **Why the flag lives here and not in `src/serve.ts`.** The Bun wrapper
 * imports the *built* entry by path, so it and the route modules are two
 * different module graphs and cannot share a variable. `server-entry.ts` and
 * `routes/readyz.ts` are in the same bundle, which is why the entry exposes
 * these to the wrapper rather than the wrapper owning them.
 */

let draining = false

/** Whether a shutdown has begun. `/readyz` answers 503 once this is true. */
export function isDraining(): boolean {
  return draining
}

/**
 * Step 1: say not-ready.
 *
 * Idempotent, and deliberately synchronous — a second SIGTERM while the first
 * is still draining must not start a second drain, and there is nothing here
 * worth awaiting.
 */
export function beginDraining(): void {
  draining = true
}

/**
 * Step 2: release what the process holds, once nothing is using it.
 *
 * Closes the database pool if a runtime was ever built. It must *not* build
 * one: a process that is shutting down before it ever served a request would
 * otherwise run the entire OPS-2 sequence — migrations included — on its way
 * out of the door.
 *
 * **The import is dynamic on purpose.** `server-entry.ts` imports this module
 * at the top level, and `../runtime` pulls in Better Auth, its plugin graph and
 * Drizzle — statically, that moved 1.28 MB out of a lazily-loaded chunk and
 * into the entry, so every process paid for the whole runtime graph at import
 * time to hold a boolean. Deferring it to the one call that needs it keeps the
 * entry the size it was.
 */
export async function releaseResources(): Promise<void> {
  const { shutdownRuntime } = await import("../runtime")
  await shutdownRuntime()
}

/** Test seam: forget that a drain happened. */
export function resetLifecycle(): void {
  draining = false
}

export interface DrainSteps {
  /** Stop being chosen. */
  beginDraining: () => void
  /** Stop accepting, and resolve once the in-flight requests have finished. */
  stopAccepting: () => Promise<void>
  /** Cut whatever is left, once the grace period is spent. */
  forceClose: () => void
  /** Stop holding. Runs after `stopAccepting`, whichever way that ended. */
  release: () => Promise<void>
  /** The grace period, from `server.shutdownTimeoutSeconds`. */
  timeoutMs: number
  /** Injected by the test; production passes nothing and gets the globals. */
  timers?: {
    set: (fn: () => void, ms: number) => unknown
    clear: (handle: unknown) => void
  }
}

/**
 * The order of a drain, separable from the process that performs one.
 *
 * It lives here rather than inline in `src/serve.ts` because the *ordering* is
 * the whole content — release before the in-flight requests have finished and
 * an orderly rollout becomes a burst of 500s — and `serve.ts` calls
 * `Bun.serve` at module load, so nothing can import it to check. This can be
 * called with four fakes and the order observed, which is what
 * `lifecycle.test.ts` does. That matters more than usual here: on Windows a
 * SIGTERM cannot reach a handler at all, so a developer machine can never
 * exercise the real path, and only TST-8's containerised smoke test will.
 *
 * Signal handling stays in `serve.ts`: that is the layer that owns the socket,
 * and a handler is not a thing worth abstracting.
 */
export async function runDrain(steps: DrainSteps): Promise<void> {
  const timers = steps.timers ?? {
    set: (fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)
      // `unref` so a drain that finishes early is not held open by its own
      // deadline; otherwise every clean shutdown would still wait out the
      // full grace period before the process could exit.
      handle.unref()
      return handle
    },
    clear: (handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }

  steps.beginDraining()

  const deadline = timers.set(() => {
    steps.forceClose()
  }, steps.timeoutMs)

  try {
    await steps.stopAccepting()
  } finally {
    timers.clear(deadline)
    // The pool closes whether the wait ended cleanly or was cut short. A
    // `stopAccepting` that rejects must not leave the process holding
    // connections it will never use again.
    await steps.release()
  }
}
