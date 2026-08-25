/**
 * The container smoke test (TST-8, OPS-13).
 *
 * Everything else in this repository tests the application. This tests the
 * *image*: that the thing CI publishes starts, migrates, serves the protocol,
 * signs somebody in, mints a token, and stops when it is told to. Those are
 * different questions, and each of the defects this file was written to catch
 * — a missing file in the final stage, a signal that never reaches the
 * process, a health check probing the wrong path — is invisible to every unit
 * and integration test in the suite.
 *
 * The sequence, in order, because each step depends on the last:
 *
 *   1. compose up, against a **generated** config folder and its own project
 *      name, so it can never touch the operator's stack or the persistent
 *      `idp` schema (P0'.2);
 *   2. `/readyz` — and the time it took, which is OPS-13's start-up budget;
 *   3. discovery and the JWKS, fetched as a client would;
 *   4. **the forced password change, scripted.** A fresh stack's only account
 *      is the bootstrap admin, and it carries `mustChangePassword`. A smoke
 *      test that only posted the `.env` password would be asserting that a
 *      sign-in *starts*, not that anyone can use the deployment;
 *   5. a session JWT, verified against the JWKS published in step 3 — which is
 *      what proves the signing key survived the image build;
 *   6. RSS, from `docker stats`, against OPS-13's ceiling;
 *   7. SIGTERM, and the exit code. `docker compose stop` sends exactly that,
 *      and OPS-4 says the answer is 0.
 *
 * Run it locally with `bun run scripts/smoke-test.ts --build`; CI runs it
 * against an image it has already built.
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createLocalJWKSet, jwtVerify } from "jose"

const PROJECT = "idp-smoke"
const PORT = Number(process.env.SMOKE_PORT ?? 3399)
const ORIGIN = `http://127.0.0.1:${PORT}`
const IMAGE = process.env.IDP_IMAGE ?? "semantius-idp:local"

/** OPS-13, all three. */
const BUDGET = {
  readySeconds: 5,
  rssBytes: 256 * 1024 * 1024,
  imageBytes: 300 * 1024 * 1024,
}

const ADMIN_EMAIL = "smoke-admin@example.com"
const BOOTSTRAP_PASSWORD = "smoke-bootstrap-password-01"
const CHOSEN_PASSWORD = "smoke-chosen-password-02"

let failures = 0

function check(label: string, ok: boolean, detail = ""): void {
  process.stdout.write(
    `${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}\n`
  )
  if (!ok) failures += 1
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {}
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (!options.quiet && result.status !== 0) {
    process.stderr.write(`$ ${command} ${args.join(" ")}\n${result.stderr}\n`)
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

/**
 * Polls until `check` succeeds or the deadline passes.
 *
 * Returns the elapsed seconds, which is the OPS-13 measurement — so the wait
 * and the assertion are the same operation and cannot drift apart.
 */
async function waitFor(
  probe: () => Promise<boolean>,
  timeoutSeconds: number
): Promise<number | undefined> {
  const started = Date.now()
  const deadline = started + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    try {
      if (await probe()) return (Date.now() - started) / 1000
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return undefined
}

/** A throwaway config folder, so no operator file is read or written. */
function makeStack(dir: string): { configDir: string; secretsDir: string } {
  const configDir = join(dir, "config")
  const secretsDir = join(dir, "secrets")
  mkdirSync(configDir, { recursive: true })
  mkdirSync(secretsDir, { recursive: true })

  writeFileSync(join(secretsDir, "postgres_password"), "smoke-pg-password")

  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        server: {
          baseUrl: `http://127.0.0.1:${PORT}`,
          host: "0.0.0.0",
          port: 3000,
          allowInsecureHttp: true,
          shutdownTimeoutSeconds: 10,
        },
        secret: "smoke-test-secret-of-at-least-thirty-two-chars",
        database: {
          url: "${env:DATABASE_URL}",
          schema: "idp",
          migrateOnBoot: true,
        },
        site: { name: "Smoke IdP" },
        jwt: { audience: `http://127.0.0.1:${PORT}` },
        auth: { requireEmailVerification: false },
        admin: {
          bootstrap: {
            email: ADMIN_EMAIL,
            password: BOOTSTRAP_PASSWORD,
            name: "Smoke Admin",
          },
        },
        // The whole point is one clean sign-in; a limiter here would only
        // measure how fast this script types.
        rateLimit: { enabled: false },
        logging: { level: "info", format: "json" },
      },
      null,
      2
    )
  )
  // Both files are an **object with a named array**, not a bare array. The
  // loader says so and refuses to start otherwise — which is how this was
  // found, and is exactly the class of mistake a smoke test exists to catch
  // before an operator makes it.
  //
  // No clients: this test signs in at the IdP itself and exchanges the session
  // for a JWT, which needs none. `roles.json` could be omitted entirely (the
  // built-in catalog appears), but writing it keeps the generated folder the
  // same shape as a real one.
  writeFileSync(
    join(configDir, "oauth_clients.json"),
    JSON.stringify({ clients: [] }, null, 2)
  )
  writeFileSync(
    join(configDir, "roles.json"),
    JSON.stringify(
      {
        roles: [
          { name: "admin", description: "Administrator." },
          { name: "user", description: "Default role.", default: true },
        ],
      },
      null,
      2
    )
  )

  return { configDir, secretsDir }
}

function composeEnv(configDir: string, secretsDir: string) {
  return {
    IDP_IMAGE: IMAGE,
    IDP_PORT: String(PORT),
    IDP_BASE_URL: ORIGIN,
    IDP_CONFIG_HOST_DIR: configDir,
    IDP_SECRETS_DIR: secretsDir,
    POSTGRES_PASSWORD: "smoke-pg-password",
    IDP_SECRET: "smoke-test-secret-of-at-least-thirty-two-chars",
    IDP_ADMIN_EMAIL: ADMIN_EMAIL,
    IDP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  }
}

/** Everything `set-cookie` gave us, as one request header. */
function cookiesFrom(response: Response, previous = ""): string {
  const jar = new Map<string, string>()
  for (const pair of previous.split("; ").filter(Boolean)) {
    const index = pair.indexOf("=")
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1))
  }
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";")
    if (!pair) continue
    const index = pair.indexOf("=")
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1)
    // A `Max-Age=0` deletion is a real event: dropping the name is what makes
    // the jar reflect what a browser would send next.
    if (value === "") jar.delete(name)
    else jar.set(name, value)
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "idp-smoke-"))
  const { configDir, secretsDir } = makeStack(workDir)
  const env = composeEnv(configDir, secretsDir)
  const compose = (...args: string[]) =>
    run("docker", ["compose", "-p", PROJECT, ...args], { env })

  try {
    if (process.argv.includes("--build")) {
      process.stdout.write("building image…\n")
      const built = run("docker", [
        "build",
        "-t",
        IMAGE,
        "--build-arg",
        "IDP_VERSION=0.0.0-smoke",
        ".",
      ])
      if (built.code !== 0) {
        check("image builds", false)
        return
      }
    }

    // ---- 1. up ----------------------------------------------------------
    compose("down", "-v", "--remove-orphans")
    process.stdout.write("starting the stack…\n")
    const up = compose("up", "-d", "--wait", "--wait-timeout", "180", "--quiet-pull")
    check("compose up", up.code === 0)
    if (up.code !== 0) return

    // ---- 2. readiness, and how long it took -----------------------------
    const readyIn = await waitFor(async () => {
      const response = await fetch(`${ORIGIN}/readyz`)
      return response.status === 200
    }, 60)
    check("/readyz answers 200", readyIn !== undefined)

    // Measured from the first probe, not from `compose up`: OPS-13's budget
    // is "ready < 5 s excluding migrations", and `--wait` has already waited
    // for the container's own health check, which covers the migration.
    check(
      `ready within ${BUDGET.readySeconds}s (OPS-13)`,
      (readyIn ?? Infinity) < BUDGET.readySeconds,
      `${(readyIn ?? -1).toFixed(2)}s`
    )

    // ---- 3. discovery and JWKS ------------------------------------------
    const discovery = await fetch(`${ORIGIN}/.well-known/openid-configuration`)
    const metadata = await asJson<Record<string, string>>(discovery)
    check("discovery document", discovery.status === 200)
    check(
      "issuer matches the configured baseUrl",
      metadata?.issuer === ORIGIN,
      String(metadata?.issuer)
    )

    const jwksResponse = await fetch(`${ORIGIN}/.well-known/jwks.json`)
    const jwks = await asJson<{ keys: unknown[] }>(jwksResponse)
    const keyCount = jwks?.keys?.length ?? 0
    check(
      "JWKS publishes a signing key",
      jwksResponse.status === 200 && keyCount > 0,
      `${keyCount} key(s)`
    )

    // ---- 4. sign in, through the forced change --------------------------
    const post = (path: string, body: unknown, cookie: string) =>
      fetch(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      })

    const signedIn = await post(
      "/api/auth/sign-in/email",
      { email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD },
      ""
    )
    check("bootstrap admin signs in", signedIn.status === 200)
    let cookie = cookiesFrom(signedIn)

    // FR-ADMIN-1: the account exists only to be used once. Until this
    // succeeds, the deployment has no usable administrator.
    const changed = await post(
      "/api/auth/change-password",
      {
        currentPassword: BOOTSTRAP_PASSWORD,
        newPassword: CHOSEN_PASSWORD,
      },
      cookie
    )
    check("forced password change completes", changed.status === 200)
    cookie = cookiesFrom(changed, cookie)

    const again = await post(
      "/api/auth/sign-in/email",
      { email: ADMIN_EMAIL, password: CHOSEN_PASSWORD },
      ""
    )
    check("the new password signs in", again.status === 200)
    cookie = cookiesFrom(again)

    // ---- 5. a token, verified against the published keys -----------------
    const tokenResponse = await fetch(`${ORIGIN}/api/auth/token`, {
      headers: { cookie },
    })
    const token = (await asJson<{ token?: string }>(tokenResponse))?.token
    check("session JWT issued", tokenResponse.status === 200 && !!token)

    if (token && jwks) {
      try {
        const keySet = createLocalJWKSet(
          jwks as Parameters<typeof createLocalJWKSet>[0]
        )
        const { payload } = await jwtVerify(token, keySet, { issuer: ORIGIN })
        check("JWT verifies against the published JWKS", true)
        check(
          "JWT is not born expired",
          typeof payload.exp === "number" && payload.exp * 1000 > Date.now(),
          `exp ${payload.exp}`
        )
      } catch (error) {
        check(
          "JWT verifies against the published JWKS",
          false,
          error instanceof Error ? error.message : String(error)
        )
      }
    }

    // ---- 6. footprint ----------------------------------------------------
    const stats = run("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.MemUsage}}",
      `${PROJECT}-idp-1`,
    ])
    const rss = parseBytes(stats.stdout.split("/")[0] ?? "")
    check(
      `idle RSS under ${mib(BUDGET.rssBytes)} (OPS-13)`,
      rss !== undefined && rss < BUDGET.rssBytes,
      rss === undefined ? stats.stdout.trim() : mib(rss)
    )

    const size = run("docker", [
      "image",
      "inspect",
      IMAGE,
      "--format",
      "{{.Size}}",
    ])
    const imageBytes = Number(size.stdout.trim())
    check(
      `image under ${mib(BUDGET.imageBytes)} (OPS-13)`,
      Number.isFinite(imageBytes) && imageBytes < BUDGET.imageBytes,
      mib(imageBytes)
    )

    // ---- 7. SIGTERM, and the exit code -----------------------------------
    //
    // `compose stop` sends SIGTERM and waits `stop_grace_period`. If the drain
    // is wired correctly the process exits 0 well inside it; if the signal
    // never reaches it, Docker sends SIGKILL and the code is 137.
    const stopped = compose("stop", "-t", "30", "idp")
    check("compose stop", stopped.code === 0)

    const exit = run("docker", [
      "inspect",
      "-f",
      "{{.State.ExitCode}}",
      `${PROJECT}-idp-1`,
    ])
    const exitCode = Number(exit.stdout.trim())
    check(
      "exits 0 on SIGTERM (OPS-4)",
      exitCode === 0,
      exitCode === 137 ? "137 — SIGKILL: the signal never reached it" : exit.stdout.trim()
    )
  } finally {
    // **The logs, whenever anything failed.** Without this the failure reads
    // "container idp-smoke-idp-1 is unhealthy" and nothing else, and the
    // actual cause — a module the final stage does not contain, a config the
    // container cannot parse — is in a container that is about to be deleted.
    // That exact loop cost an hour the first time this ran.
    if (failures > 0) {
      const logs = compose("logs", "--no-color", "--tail", "80", "idp")
      process.stderr.write(`\n--- idp container logs ---\n${logs.stdout}\n`)
    }
    compose("down", "-v", "--remove-orphans")
    rmSync(workDir, { recursive: true, force: true })
  }

  process.stdout.write(
    failures === 0 ? "\nsmoke test passed\n" : `\n${failures} check(s) failed\n`
  )
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * The body as JSON, or `undefined`.
 *
 * Every step here reads a response that a *broken* deployment might not have
 * made JSON at all — a 500 from a route that threw, an HTML error page. The
 * first version destructured straight from `.json()`, so one failed step
 * crashed the script with `undefined is not an object` and every check after
 * it went unreported, including the ones that would have said what was wrong.
 */
async function asJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

/** `123.4MiB` → bytes. `docker stats` chooses the unit; this reads all of them. */
function parseBytes(value: string): number | undefined {
  const match = /([\d.]+)\s*([KMGT]?i?B)/i.exec(value.trim())
  if (!match) return undefined
  const scale: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
  }
  const factor = scale[match[2]!.toLowerCase()]
  return factor === undefined ? undefined : Number(match[1]) * factor
}

await main()
