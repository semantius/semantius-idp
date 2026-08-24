import { createRouter as createTanStackRouter } from "@tanstack/react-router"

import { runtimeBasePath } from "./lib/base-path"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
  const basepath = runtimeBasePath()

  const router = createTanStackRouter({
    routeTree,
    basepath,

    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  })

  // Start's request handler calls `router.update({ …, basepath })` on every
  // request with the basepath that was baked into the build, which would
  // undo the runtime value above (spike S3). Re-applying ours on every update
  // is the seam that keeps one image serving both `/` and `/idp`; if a future
  // version stops passing `basepath`, this still holds the right value.
  const update = router.update.bind(router)
  router.update = (options) => update({ ...options, basepath })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
