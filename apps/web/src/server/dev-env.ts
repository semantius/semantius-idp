/**
 * Development-only `.env` loading.
 *
 * In a container every variable arrives from the environment — that is the
 * whole point of CFG-2/CFG-3, and nothing here runs. On a developer machine the
 * dev server is started by Vite, which does not put a repo-root `.env` into
 * `process.env`, so the config folder's `${env:…}` placeholders would fail to
 * resolve for no good reason.
 *
 * Deliberately narrow: it fills in **missing** variables only, never overrides
 * one that is already set, and it is a no-op in production.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

let loaded = false

/** Candidate locations, nearest first. */
function candidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    join(here, "..", "..", ".env"), // apps/web/.env
    join(here, "..", "..", "..", "..", ".env"), // repo root
  ]
}

export function loadDevEnv(): void {
  if (loaded) return
  loaded = true
  if (process.env.NODE_ENV === "production") return

  for (const path of candidates()) {
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(
        line
      )
      if (!match) continue
      const name = match[1]!
      if (process.env[name] !== undefined) continue
      process.env[name] = match[2]!.trim().replace(/^["']|["']$/g, "")
    }
  }
}
