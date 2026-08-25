import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { E2E } from "../playwright.config"
import { makeStack, startStack } from "./stack"
import type { Stack } from "./stack"

/**
 * Brings the stacks up before any spec runs (TST-6).
 *
 * The handles are written to a file rather than kept in memory, because
 * Playwright runs `globalSetup`, the workers and `globalTeardown` in separate
 * processes — a module-level variable here is invisible to every spec.
 *
 * **`E2E_ONLY` starts a subset**, e.g. `E2E_ONLY=host-root` while a spec is
 * being written: one stack instead of two turns a four-minute wait into a
 * two-minute one. It is not derived from `--project`, because the config
 * `globalSetup` receives lists every project whatever was asked for, and a
 * filter that silently did nothing would be worse than no filter. CI sets
 * neither and gets both.
 */
export const STACKS_FILE = join(tmpdir(), "idp-e2e-stacks.json")

export default async function globalSetup(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "idp-e2e-"))
  const only = (process.env.E2E_ONLY ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")

  const all: Record<string, Stack> = {
    "host-root": makeStack({
      project: E2E.hostRoot.project,
      port: E2E.hostRoot.port,
      basePath: E2E.hostRoot.basePath,
      workDir: join(workDir, "root"),
    }),
    subpath: makeStack({
      project: E2E.subpath.project,
      port: E2E.subpath.port,
      basePath: E2E.subpath.basePath,
      workDir: join(workDir, "subpath"),
    }),
  }

  const stacks =
    only.length === 0
      ? all
      : Object.fromEntries(
          Object.entries(all).filter(([name]) => only.includes(name))
        )

  writeFileSync(STACKS_FILE, JSON.stringify(stacks, null, 2))

  // Sequential, not parallel. Both pull the same Postgres image on a cold
  // machine and both run migrations; starting them together makes the first
  // failure of either one harder to attribute.
  for (const stack of Object.values(stacks)) {
    process.stdout.write(`e2e: starting ${stack.project} on ${stack.baseURL}\n`)
    await startStack(stack)
  }
}
