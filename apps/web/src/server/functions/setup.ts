/**
 * The first-run gate, as a server function (**D52**).
 *
 * `/`, `/login` and `/setup` all have to know whether the deployment still has
 * no users, and a route loader is isomorphic — it runs in the browser on every
 * client-side navigation — so the check cannot reach for `getRuntime()`
 * directly without dragging Drizzle and the `postgres` driver into the client
 * bundle. `createServerFn` is the seam; `functions/ui.ts` explains the rule at
 * length.
 *
 * The answer is memoised in the process once it is `false` (see
 * `admin/first-user.ts`), so this is one round trip and no query on every page
 * a signed-out visitor loads.
 */

import { createServerFn } from "@tanstack/react-start"

import { isSetupPending } from "../admin/first-user"
import { getRuntime } from "../runtime"

export const fetchSetupPending = createServerFn({ method: "GET" }).handler(
  async (): Promise<boolean> => {
    const runtime = await getRuntime()
    return isSetupPending(runtime.database)
  }
)
