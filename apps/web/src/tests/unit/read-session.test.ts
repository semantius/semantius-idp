import { APIError } from "better-auth/api"
import { describe, expect, it } from "vitest"

import { readSession } from "@/server/http/session"
import type { Runtime } from "@/server/runtime"

/**
 * `readSession` telling "nobody is signed in" apart from "the database did not
 * answer" (**D59**).
 *
 * It used to say `.catch(() => null)`, so both came out as an anonymous
 * visitor. On 2026-08-26 a schema was dropped under a running dev server and
 * the result was `Failed query: select … from "idp"."session"` in the log next
 * to a perfectly ordinary sign-in page on the screen — an outage wearing a
 * sign-out's clothes, on the one page whose whole job is to say who you are.
 *
 * The rule is Better Auth's own: `dispatch` turns a refusal into an `APIError`
 * and rethrows everything else untouched, so a driver failure arrives as a
 * plain `Error`.
 */

/** Just enough runtime for the one call under test. */
function runtimeThatThrows(error: unknown): Runtime {
  return {
    auth: {
      api: {
        getSession: () => Promise.reject(error),
      },
    },
  } as unknown as Runtime
}

const request = new Request("https://idp.example.com/account")

describe("readSession (D59)", () => {
  it("answers null for a refusal, which is still nobody signed in", async () => {
    // A dead, revoked or banned session. The caller belongs on the login page,
    // not on an error page, so this is the case the original catch got right.
    await expect(
      readSession(
        runtimeThatThrows(
          new APIError("UNAUTHORIZED", { message: "Session expired" })
        ),
        request
      )
    ).resolves.toBeNull()
  })

  it("lets a database failure through instead of dressing it as a sign-out", async () => {
    // The whole point. A `postgres`/Drizzle failure is not an APIError,
    // because `dispatch` only wraps refusals.
    const failure = new Error(
      'Failed query: select "id" from "idp"."session" where token = $1'
    )
    await expect(
      readSession(runtimeThatThrows(failure), request)
    ).rejects.toThrow(failure)
  })

  it("lets a 5xx refusal through too", async () => {
    // An APIError, but one that says the server broke rather than that the
    // caller is unwelcome. Silently signing somebody out over it would hide
    // exactly the same class of fault as the plain Error above.
    await expect(
      readSession(
        runtimeThatThrows(
          new APIError("INTERNAL_SERVER_ERROR", { message: "boom" })
        ),
        request
      )
    ).rejects.toThrow(APIError)
  })
})
