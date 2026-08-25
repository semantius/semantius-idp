/**
 * `/readyz` while draining (OPS-3, OPS-4).
 *
 * The flag has its own test; this asserts the thing that actually matters to
 * an orchestrator — that the *route* short-circuits on it, and answers 503
 * **before** running any check. Every check would still pass during a drain:
 * the pool is open and the migrations are current, right up until they are
 * not, and answering 200 for those last seconds is precisely how a rolling
 * deploy keeps sending requests to a container on its way out.
 *
 * Short-circuiting is also why this can be a unit test at all: the draining
 * branch returns before it touches `getRuntime()`, so there is no database
 * here and no start-up sequence to stand up.
 */

import { afterEach, describe, expect, it } from "vitest"

import { Route } from "@/routes/readyz"
import { beginDraining, resetLifecycle } from "@/server/http/lifecycle"

/**
 * The route's GET handler.
 *
 * `handlers` is typed as a union — a record, or a function that builds one —
 * so the record branch has to be asserted. The runtime check below is what
 * actually holds this honest: if the route stops declaring a GET, or declares
 * it through the function form, this throws rather than passing vacuously.
 */
function handler(): () => Promise<Response> {
  const handlers = Route.options.server?.handlers as
    | { GET?: unknown }
    | undefined
  const get = handlers?.GET
  if (typeof get !== "function") {
    throw new Error("/readyz has no GET handler in record form")
  }
  return get as () => Promise<Response>
}

afterEach(() => {
  resetLifecycle()
})

describe("/readyz", () => {
  it("answers 503 once a drain has begun", async () => {
    beginDraining()

    const response = await handler()()

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: "draining" })
    // Never cached: a stale 200 in a proxy outlives the container.
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("does not reach the runtime to say so", async () => {
    // No database is configured in this project. If the draining branch ran
    // any check, this would throw or hang rather than answer.
    beginDraining()

    await expect(handler()()).resolves.toBeInstanceOf(Response)
  })
})
