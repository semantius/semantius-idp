/**
 * The one server function every page's shell goes through.
 *
 * **Why this file exists at all.** A TanStack Start route `loader` is
 * isomorphic — it runs on the server for the first paint and in the browser on
 * every client-side navigation — so anything it imports is pulled into the
 * *client* bundle. The loaders here reached for `getRuntime()`, which is the
 * whole IdP: Better Auth, Drizzle, the `postgres` driver, the migrator and the
 * advisory-lock helpers. All of it was being shipped to the browser, where it
 * threw `ReferenceError: Buffer is not defined` before React could hydrate.
 *
 * `createServerFn` is the seam that stops it. The Start plugin compiles the
 * handler body out of the client build and leaves an RPC stub, so the server
 * graph stays on the server and the loader keeps working in both places.
 *
 * The rule this file encodes, and the reason to keep the surface this small:
 * **nothing under `@/server` that touches the database may be imported by a
 * route module outside a `server.handlers` block or a server function.**
 */

import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

import { readSession } from "../http/session"
import { getRuntime } from "../runtime"
import { buildUiContext } from "../ui-context"
import type { UiContext } from "../ui-context"

/**
 * The capability flags and branding the public pages render from.
 *
 * Constant for the life of the process (configuration is read once)
 * with one exception: `adminDatabaseEnabled` is `false` until the request
 * carries a session, so the sign-in page does not tell an anonymous visitor
 * that a SQL console exists (security review 2026-09). A cached, non
 * -authoritative read is all that needs — the flag decides whether a nav
 * entry renders, and the endpoint behind it has its own gate. The root route
 * fetches this once per navigation and every child reads it from there.
 */
export const fetchUiContext = createServerFn({ method: "GET" }).handler(
  async (): Promise<UiContext> => {
    const runtime = await getRuntime()
    const session = await readSession(runtime, getRequest())
    return buildUiContext(
      runtime.config,
      runtime.config.file.site.defaultLocale,
      { signedIn: session !== null }
    )
  }
)
