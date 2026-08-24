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

import { getRuntime } from "../runtime"
import { buildUiContext } from "../ui-context"
import type { UiContext } from "../ui-context"

/**
 * The capability flags and branding the public pages render from.
 *
 * Constant for the life of the process (configuration is read once, CFG-5),
 * which is why the root route fetches it and every child reads it from there
 * rather than asking again.
 */
export const fetchUiContext = createServerFn({ method: "GET" }).handler(
  async (): Promise<UiContext> => {
    const runtime = await getRuntime()
    return buildUiContext(
      runtime.config,
      runtime.config.file.site.defaultLocale
    )
  }
)
