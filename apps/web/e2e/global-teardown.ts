import { readFileSync, rmSync } from "node:fs"

import { STACKS_FILE } from "./global-setup"
import { stopStack } from "./stack"
import type { Stack } from "./stack"

/**
 * Takes both stacks down, whatever happened (TST-6).
 *
 * `-v` on the way out: each stack owns a Postgres volume, and leaving them
 * behind means the next run starts against a database that already has the
 * users the last one created — which is how an e2e suite becomes order-
 * dependent without anyone deciding it should be.
 */
export default function globalTeardown(): void {
  let stacks: Record<string, Stack>
  try {
    stacks = JSON.parse(readFileSync(STACKS_FILE, "utf8")) as Record<
      string,
      Stack
    >
  } catch {
    // Setup failed before it wrote the file; there is nothing to stop.
    return
  }

  for (const stack of Object.values(stacks)) stopStack(stack)
  rmSync(STACKS_FILE, { force: true })
}
