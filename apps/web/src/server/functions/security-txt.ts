/**
 * Reading `security.txt` out of the config folder (FR-OIDC-15, RFC 9116).
 *
 * A server function rather than a direct read in the route so the `node:fs`
 * import cannot reach the client bundle, and cached for the life of the
 * process because the config folder is mounted read-only (CFG-1) and read
 * once (CFG-5) — a per-request `readFile` on a path an operator controls is
 * an easy denial-of-service surface for no benefit.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { getRuntime } from "../runtime"

/** `null` means "no such file", which the route turns into a 404. */
let cached: string | null | undefined

export async function readSecurityTxt(): Promise<string | null> {
  if (cached !== undefined) return cached
  const runtime = await getRuntime()
  try {
    cached = readFileSync(join(runtime.configDir, "security.txt"), "utf8")
  } catch {
    cached = null
  }
  return cached
}

/** Test seam: forget the cached answer. */
export function resetSecurityTxt(): void {
  cached = undefined
}
