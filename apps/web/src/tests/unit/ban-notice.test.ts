import { describe, expect, it } from "vitest"

import { banNoticeFor } from "@/server/auth/ban-notice"
import { createAuthSchema } from "@/server/db/schema/auth-schema"
import type { Runtime } from "@/server/runtime"

/**
 * What `/banned` is told (FR-ADMIN-4).
 *
 * The page reads `reason` and `expires` out of its query string, so the
 * contract worth pinning is the shape of that string — including the case
 * where there is nothing to say, which is a real ban and not an error.
 *
 * The schema is the real one so the `eq()` in the query is built against real
 * columns; only the query's *execution* is stubbed. A test that faked the
 * columns as well would pass against code that could never run.
 */
type Row = { reason: string | null; expires: Date | null }

function runtimeReturning(row?: Row): Runtime {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(row ? [row] : []),
  }
  return {
    database: {
      schema: createAuthSchema("idp"),
      db: { select: () => chain },
    },
  } as unknown as Runtime
}

describe("banNoticeFor", () => {
  it("carries the reason and the expiry", async () => {
    const expires = new Date("2026-09-01T12:00:00.000Z")
    const notice = await banNoticeFor(
      runtimeReturning({ reason: "Repeatedly ignored the rules", expires }),
      "someone@example.com"
    )

    const params = new URLSearchParams(notice)
    expect(params.get("reason")).toBe("Repeatedly ignored the rules")
    expect(params.get("expires")).toBe(expires.toISOString())
  })

  it("says nothing about a permanent ban with no recorded reason", async () => {
    // The page then shows only "contact your administrator", which is the
    // honest answer — inventing a reason would be worse than having none.
    expect(
      await banNoticeFor(
        runtimeReturning({ reason: null, expires: null }),
        "someone@example.com"
      )
    ).toBe("")
  })

  it("says nothing when there is no such account", async () => {
    expect(
      await banNoticeFor(runtimeReturning(), "nobody@example.com")
    ).toBe("")
  })

  it("does not query at all for an empty address", async () => {
    // `form.email` is whatever the browser posted; an empty one must not reach
    // the database, and must not produce a query string either.
    const runtime = {
      database: {
        schema: createAuthSchema("idp"),
        db: {
          select: () => {
            throw new Error("should not have queried")
          },
        },
      },
    } as unknown as Runtime

    expect(await banNoticeFor(runtime, "   ")).toBe("")
  })
})
