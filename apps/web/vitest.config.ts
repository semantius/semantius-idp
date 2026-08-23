import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

/**
 * Two projects (TST-1):
 *
 * - `unit` — pure modules, no I/O. Coverage gates live here: ≥ 85 % for the
 *   config, claims, reconcile and approval modules, ≥ 70 % overall.
 * - `integration` — runs against a real Postgres. Each file gets its own
 *   uniquely named schema, which is cheap because every table is scoped to one
 *   schema anyway (DM-4), so runs stay isolated even on a shared hosted DB.
 *
 * `test:e2e` is Playwright against the built image and is configured separately.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/tests/integration/**/*.test.ts"],
          environment: "node",
          // A schema create + migrate per file is the slow part; give it room
          // and keep files serial so advisory-lock behaviour stays observable.
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/server/**/*.ts"],
      exclude: ["src/server/db/schema/**", "**/*.d.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
        // TST-1 raises the bar for the modules a mistake would be most
        // expensive in.
        "src/server/config/**/*.ts": {
          lines: 85,
          functions: 85,
          branches: 85,
          statements: 85,
        },
        "src/server/claims/**/*.ts": {
          lines: 85,
          functions: 85,
          branches: 85,
          statements: 85,
        },
        "src/server/oidc/**/*.ts": {
          lines: 85,
          functions: 85,
          branches: 85,
          statements: 85,
        },
      },
    },
  },
})
