import { readFileSync } from "node:fs"

import { test as base } from "@playwright/test"
import type { Page } from "@playwright/test"

import { STACKS_FILE } from "./global-setup"
import type { Stack } from "./stack"

/**
 * The stack the current Playwright project is driving.
 *
 * Read from disk because `globalSetup` runs in a different process from the
 * workers. Cached per worker, so it is one read rather than one per test.
 */
let cache: Record<string, Stack> | undefined

function stacks(): Record<string, Stack> {
  cache ??= JSON.parse(readFileSync(STACKS_FILE, "utf8")) as Record<
    string,
    Stack
  >
  return cache
}

/**
 * Navigation that respects the mount path.
 *
 * **This exists because Playwright's `baseURL` cannot.** `page.goto("/login")`
 * resolves the way `new URL` does — an absolute path replaces the *whole* path
 * of the base — so against `http://127.0.0.1:3411/idp` it requests
 * `http://127.0.0.1:3411/login`. That is the origin root, which under a
 * sub-path deployment belongs to somebody else's application (OPS-10). The
 * sub-path project did exactly that on its first run: it drove the wrong URL
 * and failed with "no Password field", which is a confusing way to learn that
 * the *test* was wrong rather than the deployment.
 *
 * A trailing slash on `baseURL` plus relative paths would also work, and would
 * go wrong again the first time somebody typed a leading slash. This cannot.
 */
export interface App {
  /** Absolute URL for a path relative to the application root. */
  url: (path: string) => string
  /** `page.goto`, with the mount path applied. */
  goto: (path: string) => ReturnType<Page["goto"]>
  /** The mount path — `""` at the host root, `/idp` behind Caddy. */
  basePath: string
}

export const test = base.extend<{ app: App }, { stack: Stack }>({
  // **Worker-scoped**, which is what it actually is: one stack serves every
  // test the worker runs. It also has to be, because `afterAll` can only see
  // worker fixtures, and the spec that reconfigures the stack puts the
  // configuration back there (`signup.spec.ts`).
  stack: [
    // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature
    async ({}, use, workerInfo) => {
      const stack = stacks()[workerInfo.project.name]
      if (!stack) {
        throw new Error(`no stack for the ${workerInfo.project.name} project`)
      }
      await use(stack)
    },
    { scope: "worker" },
  ],

  app: async ({ page, stack }, use) => {
    const url = (path: string) =>
      path.startsWith("http") ? path : `${stack.baseURL}${path}`
    await use({
      url,
      goto: (path) => page.goto(url(path)),
      basePath: stack.basePath,
    })
  },
})

export { expect } from "@playwright/test"
