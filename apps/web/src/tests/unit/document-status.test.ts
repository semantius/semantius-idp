import { describe, expect, it } from "vitest"

import {
  currentRequest,
  setDocumentStatus,
  withRequestContext,
} from "@/server/http/request-log"

/**
 * The document status a loader can ask for (FR-ROLE-3).
 *
 * It exists because Start's `setResponseStatus` does not reach an SSR page:
 * `renderRouterToStream` builds that response from the router's own status
 * store, which only ever holds 404, 500 or 200. The admin refusal needs 403,
 * so the loader leaves it here and `server-entry.ts` applies it.
 *
 * Asserted rather than assumed, because the e2e suite is what caught the first
 * attempt — `setResponseStatus(403)` typechecked, ran, and changed nothing.
 */
describe("setDocumentStatus", () => {
  it("carries a status out of the request it was set in", () => {
    withRequestContext({ requestId: "r1" }, () => {
      expect(currentRequest()?.documentStatus).toBeUndefined()
      setDocumentStatus(403)
      expect(currentRequest()?.documentStatus).toBe(403)
    })
  })

  it("keeps the first answer, so a later milder one cannot mask it", () => {
    withRequestContext({ requestId: "r2" }, () => {
      setDocumentStatus(403)
      setDocumentStatus(200)
      expect(currentRequest()?.documentStatus).toBe(403)
    })
  })

  it("does nothing outside a request", () => {
    // Start-up, the CLI, a background job: all real ways for this to run.
    expect(() => {
      setDocumentStatus(403)
    }).not.toThrow()
    expect(currentRequest()).toBeUndefined()
  })

  it("does not leak between requests", () => {
    withRequestContext({ requestId: "r3" }, () => {
      setDocumentStatus(403)
    })
    withRequestContext({ requestId: "r4" }, () => {
      expect(currentRequest()?.documentStatus).toBeUndefined()
    })
  })
})
