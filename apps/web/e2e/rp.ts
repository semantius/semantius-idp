import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { join } from "node:path"

import { RP_PORT } from "./stack"
import type { Stack } from "./stack"

/**
 * Running `e2e/sample-rp.ts` for the duration of a spec (TST-4, TST-6).
 *
 * **A separate process, started with `bun`**, and not an in-test server. The
 * sample RP is a deliverable — DOC-3 points a reader at it — so the thing the
 * suite drives has to be the file the documentation names, run the way the
 * documentation says to run it. An `openid-client` instance constructed inside
 * the test would prove the protocol works and prove nothing about the sample.
 */

export interface RelyingParty {
  url: string
  stop: () => Promise<void>
}

export interface RpClient {
  clientId: string
  clientSecret: string
}

export async function startRelyingParty(
  stack: Stack,
  rpClient: RpClient
): Promise<RelyingParty> {
  const script = join(import.meta.dirname, "sample-rp.ts")
  const url = `http://127.0.0.1:${RP_PORT}`

  // **Nothing may already be listening.** A leftover RP from an interrupted
  // run answers `/health` perfectly well, so the readiness poll below would
  // report success while the new child died on `EADDRINUSE` — and the specs
  // would then drive whatever code that old process happens to be running.
  // That cost an afternoon: a stale RP from a debugging session made an
  // already-fixed sample look unfixed, twice.
  if (await isListening(url)) {
    throw new Error(
      `something is already listening on ${url}. A sample RP from an earlier ` +
        `run is still up; stop it before running these specs.`
    )
  }

  const child = spawn("bun", [script], {
    env: {
      ...process.env,
      RP_ISSUER: stack.baseURL,
      RP_CLIENT_ID: rpClient.clientId,
      RP_CLIENT_SECRET: rpClient.clientSecret,
      RP_PORT: String(RP_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const output: string[] = []
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()))
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()))

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `sample RP exited with ${child.exitCode}:\n${output.join("")}`
      )
    }
    try {
      const response = await fetch(`${url}/health`)
      if (response.ok) return { url, stop: () => stop(child) }
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  await stop(child)
  throw new Error(`sample RP never became ready:\n${output.join("")}`)
}

async function isListening(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
    return true
  } catch {
    return false
  }
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    child.once("exit", () => resolve())
    child.kill()
    // Windows has no graceful signal for a console process; if it is still
    // there after a moment, take the port back the blunt way.
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL")
      resolve()
    }, 3_000)
  })
}
