/**
 * A failed start-up says why, once.
 *
 * `getRuntime()` rethrows to whoever asked, and on 2026-09-11 whoever asked was
 * a page's root loader, whose failure the document shell then buried under a
 * `TypeError` of its own. The reason — `relation "account" already exists` —
 * was in no log at all. These pin that it is logged, and that a retried
 * start-up failing the same way does not print it again on every request.
 *
 * The configuration folder points nowhere, so start-up fails before any
 * database is looked for, and the database URLs point at a closed port in case
 * that ever changes: `loadDevEnv()` would otherwise fill them from the
 * repo-root `.env`, which is the developer's own database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getRuntime } from "@/server/runtime"

const ISOLATED_ENV = {
  IDP_CONFIG_DIR: "/no-such-config-folder",
  DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
  DATABASE_URL_ADMIN: "postgres://nobody@127.0.0.1:1/none",
}
const previousEnv: Record<string, string | undefined> = {}

describe("a start-up that fails", () => {
  let written: string[]

  beforeEach(() => {
    for (const [name, value] of Object.entries(ISOLATED_ENV)) {
      previousEnv[name] = process.env[name]
      process.env[name] = value
    }
    written = []
    // Error records go to stderr (`logger.ts`); both are captured so a move
    // between them does not read as the log line disappearing.
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation((chunk) => {
        written.push(String(chunk))
        return true
      })
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it("is logged with its reason, and only once while the reason stays the same", async () => {
    await expect(getRuntime()).rejects.toThrow()
    await expect(getRuntime()).rejects.toThrow()

    const failures = written
      .filter((line) => line.includes('"start-up failed"'))
      .map((line) => JSON.parse(line) as { level: string; reason: string })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.level).toBe("error")
    expect(failures[0]?.reason).toMatch(/no-such-config-folder|config/i)
  })
})
