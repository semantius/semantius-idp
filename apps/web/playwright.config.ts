import { defineConfig, devices } from "@playwright/test"

/**
 * End-to-end tests against the **built image** (TST-6, M13).
 *
 * Two projects, because the sub-path deployment is a different application as
 * far as every URL is concerned (OPS-10, risk R3) and the only honest way to
 * know it works is to drive it:
 *
 * - **host-root** — the image on `http://127.0.0.1:3410`, the ordinary case.
 * - **subpath** — the same image behind Caddy at `/idp` on `:3411`, which is
 *   where a wrong cookie `Path`, a stripped prefix or a missing origin-root
 *   RFC 8414 route shows up as a real failure rather than a code review note.
 *
 * **Why the image and not `vite dev`.** The class of defect this suite exists
 * for is the one that survives every other gate: markup that is correct and a
 * page that is nevertheless unusable. The unstyled sign-in page shipped for
 * four milestones because every gate read HTML, and reading HTML is exactly
 * what would have missed it again. So these run against what is published.
 *
 * The stacks are brought up by `e2e/stack.ts` in `globalSetup`, each with its
 * own compose project name and a **generated** config folder, so a run can
 * never touch the operator's stack or the persistent `idp` schema (P0'.2).
 */

const HOST_ROOT_PORT = Number(process.env.E2E_PORT ?? 3410)
const SUBPATH_PORT = Number(process.env.E2E_SUBPATH_PORT ?? 3411)

export const E2E = {
  hostRoot: {
    project: "idp-e2e-root",
    port: HOST_ROOT_PORT,
    baseURL: `http://127.0.0.1:${HOST_ROOT_PORT}`,
    basePath: "",
  },
  subpath: {
    project: "idp-e2e-subpath",
    port: SUBPATH_PORT,
    baseURL: `http://127.0.0.1:${SUBPATH_PORT}/idp`,
    basePath: "/idp",
  },
} as const

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // A stack per project and one browser: the bottleneck is the container, not
  // the CPU, and parallel workers against one IdP would race each other's
  // sessions and rate-limit buckets.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // `github` is there so a failure is **readable without admin rights**
  // (**D75**). The HTML report is uploaded as an artifact and downloading one
  // needs a token; job logs need admin. A Playwright failure otherwise reaches
  // an outside reader as `Process completed with exit code 1` and nothing
  // else, which is exactly the wall the container smoke test hit. The `github`
  // reporter writes `::error` lines, and those land in
  // `check-runs/{job_id}/annotations`, which anyone can read.
  reporter: process.env.CI
    ? [["list"], ["github"], ["html", { open: "never" }]]
    : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    // Every artefact only on failure: a green run should leave nothing behind,
    // and a red one should leave everything needed to understand it.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // The stacks serve plain HTTP on loopback (`allowInsecureHttp`), which is
    // the one place that is legitimate.
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: "host-root",
      use: { ...devices["Desktop Chrome"], baseURL: E2E.hostRoot.baseURL },
    },
    {
      name: "subpath",
      use: { ...devices["Desktop Chrome"], baseURL: E2E.subpath.baseURL },
      // Sequential: both projects drive containers, and starting the second
      // while the first is still signing people in only makes failures
      // harder to read.
      dependencies: ["host-root"],
    },
  ],
})
