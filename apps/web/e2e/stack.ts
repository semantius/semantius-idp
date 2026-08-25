/**
 * Bringing an IdP stack up and down for the e2e run (TST-6).
 *
 * One compose project per Playwright project, each with a **generated** config
 * folder and its own Postgres volume. Nothing here reads the operator's
 * `config/`, `.env` or database: P0'.2's rule is that a test never touches the
 * persistent `idp` schema, and the way to keep that true is to give the test
 * nothing that points at it.
 *
 * The captured mail directory is bind-mounted out of the container so the
 * specs can read a verification or reset link from the host (D30). That is the
 * whole reason the capture transport writes files at all.
 *
 * Each stack also gets a generated `.env` (D48): whole connection strings, in
 * the two roles a real one has — compose's interpolation source, and the
 * `env_file` the IdP container reads `DATABASE_URL` out of.
 *
 * And each stack is **taken through the first-run wizard in a real browser**
 * before any spec runs (D52). There is no bootstrap account any more, so a
 * stack that skipped it would have nobody to sign in as; driving it with
 * Chromium here rather than with `fetch` means the page every operator meets
 * first is exercised by the suite exactly once, deterministically, instead of
 * depending on which spec file Playwright happens to open first.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { chromium } from "@playwright/test"

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..")

/** D51: the compose files live in `docker/`, alongside the Dockerfile. */
const COMPOSE_FILES = [
  "-f",
  "docker/docker-compose.yml",
  "-f",
  "docker/docker-compose.e2e.yml",
]

export interface StackOptions {
  /** Compose project name; also the prefix of every container. */
  project: string
  /**
   * The port a browser talks to. At the host root that is the IdP container's
   * published port; behind Caddy it is Caddy's, and the IdP's own is published
   * separately (below) only so the two stacks cannot collide.
   */
  port: number
  /** `""` at the host root, `/idp` behind Caddy. */
  basePath: string
  /** Where the generated config folder and captured mail live. */
  workDir: string
}

export interface Stack extends StackOptions {
  /** What a browser should treat as the application root. */
  baseURL: string
  mailDir: string
}

const PG_PASSWORD = "e2e-postgres-password"
const SECRET = "e2e-secret-of-at-least-thirty-two-characters"

/**
 * The administrator this run creates at the first-run wizard (FR-ADMIN-1, D52).
 *
 * Per-run throwaway credentials, typed into the setup page by
 * {@link completeSetup} — not read from an environment variable, because there
 * is no longer one to read (P0'.2).
 */
export const ADMIN = {
  email: "e2e-admin@example.com",
  firstName: "E2E",
  lastName: "Admin",
  password: "e2e-admin-password-02",
}

/**
 * The port the sample relying party listens on (`e2e/sample-rp.ts`).
 *
 * One port for both clients below, because the specs run one RP at a time and
 * a second port would only be a second thing to keep in step with the
 * registered redirect URIs.
 */
export const RP_PORT = 4571

/** A confidential client for the OIDC specs. Consent is skipped (FR-OIDC-10). */
export const CLIENT = {
  clientId: "e2e-app",
  clientSecret: "e2e-client-secret-of-at-least-32-chars",
  redirectUri: `http://127.0.0.1:${RP_PORT}/callback`,
  postLogoutRedirectUri: `http://127.0.0.1:${RP_PORT}/post-logout`,
}

/**
 * The same application with `skipConsent: false`.
 *
 * A separate client rather than a reconfiguration of the first: consent is a
 * per-client property, and two clients is how a real deployment expresses
 * "this one asks and that one does not" (FR-OIDC-10).
 */
export const CONSENT_CLIENT = {
  clientId: "e2e-consent",
  clientSecret: "e2e-consent-secret-of-at-least-32-chars",
  redirectUri: CLIENT.redirectUri,
  postLogoutRedirectUri: CLIENT.postLogoutRedirectUri,
}

function docker(args: string[], env: Record<string, string>) {
  const result = spawnSync("docker", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

const behindProxy = (stack: Stack) => stack.basePath !== ""

/** The generated environment file — compose's, and the container's (D48). */
function envFile(stack: Stack): string {
  return join(stack.workDir, "stack.env")
}

/** `docker compose` with this stack's files, project and environment file. */
function compose(stack: Stack, args: string[]) {
  const profile = stack.basePath === "" ? [] : ["--profile", "caddy"]
  return docker(
    [
      "compose",
      ...COMPOSE_FILES,
      "--env-file",
      envFile(stack),
      "-p",
      stack.project,
      ...profile,
      ...args,
    ],
    composeEnv(stack)
  )
}

function composeEnv(stack: Stack): Record<string, string> {
  return {
    IDP_IMAGE: process.env.IDP_IMAGE ?? "semantius-idp:local",
    // Behind Caddy the browser talks to Caddy, so the IdP's own published port
    // is just a distinct number that cannot collide with the other stack's.
    IDP_PORT: String(behindProxy(stack) ? stack.port + 100 : stack.port),
    IDP_SUBPATH_PORT: String(stack.port),
    IDP_BASE_URL: stack.baseURL,
    IDP_BASE_PATH: stack.basePath,
    IDP_CONFIG_HOST_DIR: join(stack.workDir, "config"),
    // What the compose file's `env_file:` resolves to. A shell value beats
    // `--env-file`, so this is what decides it.
    IDP_ENV_FILE: envFile(stack),
    IDP_MAIL_HOST_DIR: stack.mailDir,
    POSTGRES_PASSWORD: PG_PASSWORD,
    // `:80` rather than a hostname: a catch-all HTTP site. Given `localhost`
    // Caddy would issue an internal certificate, listen on 443 and redirect —
    // and the test talks plain HTTP to a published port under a different
    // Host header, so it would follow that redirect to nowhere.
    IDP_DOMAIN: ":80",
  }
}

/**
 * A deep merge over plain objects, for the configuration overrides.
 *
 * Deliberately shallow about arrays — an override that names `oauth.scopes`
 * means *those* scopes, not those appended to the defaults.
 */
function merge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key]
    result[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? merge(existing, value)
        : value
  }
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  )
}

/**
 * Writes the config folder this stack runs on.
 *
 * Sign-up is **on** and approval **off**: TST-6 drives registration,
 * verification and reset, and a queue in front of them would only test the
 * queue. The approval spec turns it back on for itself, through
 * {@link reconfigure}.
 */
function writeConfig(
  stack: Stack,
  overrides: Record<string, unknown> = {}
): void {
  const configDir = join(stack.workDir, "config")
  mkdirSync(configDir, { recursive: true })
  mkdirSync(stack.mailDir, { recursive: true })

  // D48: whole connection strings, in the file compose reads and the container
  // inherits. `postgres` is the service name on the compose network.
  writeFileSync(
    envFile(stack),
    [
      `DATABASE_URL=postgres://idp:${PG_PASSWORD}@postgres:5432/idp?sslmode=disable`,
      `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      `IDP_SECRET=${SECRET}`,
      "",
    ].join("\n")
  )

  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify(
      merge({
        server: {
          baseUrl: stack.baseURL,
          host: "0.0.0.0",
          port: 3000,
          allowInsecureHttp: true,
          shutdownTimeoutSeconds: 10,
          // Behind Caddy the client address arrives in a header, and without
          // this every caller shares one rate-limit bucket (D38).
          trustProxy: stack.basePath !== "",
        },
        secret: SECRET,
        database: {
          url: "${env:DATABASE_URL}",
          schema: "idp",
          migrateOnBoot: true,
        },
        site: { name: "E2E IdP", theme: "light" },
        // A key the capture transport never calls: D30 only replaces the
        // transport when e-mail would otherwise work, so this is what takes
        // the deployment out of degraded mode (FR-MAIL-2).
        email: { resend: { apiKey: "re_e2e_never_used" }, from: "E2E <idp@example.test>" },
        signUp: { enabled: true, requireApproval: false },
        auth: { requireEmailVerification: true },
        twoFactor: { enabled: true },
        apiKeys: { enabled: true },
        jwt: { audience: stack.baseURL },
        // No `admin.bootstrap`: it no longer exists (D52). The first
        // administrator is created by `completeSetup` below, at the page.
        //
        // The suite signs in far more often than a person does; the SEC-2
        // limits have their own integration suite.
        rateLimit: { enabled: false },
        logging: { level: "info", format: "json" },
      }, overrides),
      null,
      2
    )
  )

  writeFileSync(
    join(configDir, "oauth_clients.json"),
    JSON.stringify(
      {
        clients: [
          {
            clientId: CLIENT.clientId,
            type: "web",
            name: "E2E App",
            clientSecret: CLIENT.clientSecret,
            redirectUris: [CLIENT.redirectUri],
            scopes: ["openid", "profile", "email", "offline_access"],
            enableEndSession: true,
            postLogoutRedirectUris: [CLIENT.postLogoutRedirectUri],
          },
          {
            clientId: CONSENT_CLIENT.clientId,
            type: "web",
            name: "E2E Consent App",
            clientSecret: CONSENT_CLIENT.clientSecret,
            redirectUris: [CONSENT_CLIENT.redirectUri],
            scopes: ["openid", "profile", "email", "offline_access"],
            // The whole reason this client exists (FR-OIDC-10).
            skipConsent: false,
            enableEndSession: true,
            postLogoutRedirectUris: [CONSENT_CLIENT.postLogoutRedirectUri],
          },
        ],
      },
      null,
      2
    )
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
}

export function makeStack(options: StackOptions): Stack {
  const baseURL = `http://127.0.0.1:${options.port}${options.basePath}`
  return { ...options, baseURL, mailDir: join(options.workDir, "mail") }
}

/**
 * Brings the stack up, waits for `/readyz`, and completes the first-run wizard.
 *
 * Throws with the container logs on any failure — a stack that half-started is
 * the one case where the reason is never in the Playwright output.
 */
export async function startStack(stack: Stack): Promise<void> {
  writeConfig(stack)

  compose(stack, ["down", "-v", "--remove-orphans"])
  const up = compose(stack, ["up", "-d", "--wait", "--wait-timeout", "180"])
  if (up.code !== 0) {
    throw new Error(
      `stack ${stack.project} did not come up:\n${up.stderr}\n${logs(stack)}`
    )
  }

  if (!(await waitForReady(stack))) {
    throw new Error(
      `stack ${stack.project} never became ready:\n${logs(stack)}`
    )
  }

  await completeSetup(stack)
}

/**
 * Creates the administrator every other spec signs in as, at the page (D52).
 *
 * **In a real browser**, because that is the whole point: the first-run wizard
 * is the first thing an operator ever sees, and driving it with `fetch` would
 * assert that the *endpoint* works while the page shipped with no submit
 * button. One Chromium launch per stack, in `globalSetup`, is a couple of
 * seconds against a suite that already builds an image.
 *
 * Doing it here rather than in a spec is what keeps it deterministic: every
 * other spec needs this account to exist, and a spec that raced them for it
 * would make the suite depend on the order Playwright walks the files in. That
 * the gate then closes for good is asserted by `auth.spec.ts`.
 */
async function completeSetup(stack: Stack): Promise<void> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()

    // The root, not `/setup` directly: the redirect is half of what makes the
    // wizard reachable at all, and it is deployment-shape-sensitive (OPS-10).
    await page.goto(`${stack.baseURL}/`)
    await page.waitForURL(`${stack.baseURL}/setup`, { timeout: 30_000 })

    await page.getByLabel("First name").fill(ADMIN.firstName)
    await page.getByLabel("Last name").fill(ADMIN.lastName)
    await page.getByLabel("E-mail address").fill(ADMIN.email)
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password)
    await page.getByRole("button", { name: "Create the first account" }).click()

    // The wizard signs them in, so the destination is the account page rather
    // than the login form.
    await page.waitForURL(`${stack.baseURL}/account`, { timeout: 30_000 })
  } catch (error) {
    throw new Error(
      `stack ${stack.project} could not complete the first-run wizard: ` +
        `${error instanceof Error ? error.message : String(error)}\n${logs(stack)}`
    )
  } finally {
    await browser.close()
  }
}

async function waitForReady(stack: Stack): Promise<boolean> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${stack.baseURL}/readyz`)
      if (response.status === 200) return true
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/**
 * Restarts the IdP on a changed `config.json` (CFG-5).
 *
 * Configuration is read once at start-up and there is no hot reload, so a spec
 * that needs different settings — sign-up off, approval on — has to restart
 * the container. That is cheaper than a third stack, and it is also what an
 * operator does.
 *
 * The database survives, which is the point: a user registered before the
 * restart is still there afterwards.
 *
 * Always pair with {@link resetConfig} in an `afterAll`, or the next spec file
 * inherits settings it never asked for.
 */
export async function reconfigure(
  stack: Stack,
  overrides: Record<string, unknown>
): Promise<void> {
  writeConfig(stack, overrides)
  const restarted = compose(stack, ["restart", "idp"])
  if (restarted.code !== 0) {
    throw new Error(
      `stack ${stack.project} did not restart:\n${restarted.stderr}\n${logs(stack)}`
    )
  }
  if (!(await waitForReady(stack))) {
    throw new Error(
      `stack ${stack.project} never became ready after a restart:\n${logs(stack)}`
    )
  }
}

/** Back to the configuration every other spec assumes. */
export function resetConfig(stack: Stack): Promise<void> {
  return reconfigure(stack, {})
}

export function logs(stack: Stack): string {
  return compose(stack, ["logs", "--no-color", "--tail", "120"]).stdout
}

export function stopStack(stack: Stack): void {
  // `compose()` adds `--profile caddy` for the sub-path stack, which is the
  // only one that ever starts a front end — so this removes everything either
  // stack created, and nothing it did not.
  compose(stack, ["down", "-v", "--remove-orphans"])
  rmSync(stack.workDir, { recursive: true, force: true })
}

export interface CapturedMail {
  to: string
  subject: string
  html: string
  text: string
  template: string
  capturedAt: string
}

/**
 * The most recent captured message for an address, optionally by template.
 *
 * Polls, because the send happens in the container and the file appears a
 * moment after the HTTP response that triggered it — asserting once would be a
 * race that fails about one run in five.
 */
export async function waitForMail(
  stack: Stack,
  to: string,
  options: { template?: string; timeoutMs?: number } = {}
): Promise<CapturedMail> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)
  let seen: CapturedMail[] = []

  while (Date.now() < deadline) {
    seen = readMail(stack).filter(
      (mail) =>
        mail.to.toLowerCase() === to.toLowerCase() &&
        (!options.template || mail.template === options.template)
    )
    if (seen.length > 0) return seen[seen.length - 1]!
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  const all = readMail(stack).map((m) => `${m.template} → ${m.to}`)
  throw new Error(
    `no ${options.template ?? "captured"} e-mail for ${to} within the timeout. ` +
      `Captured: ${all.length > 0 ? all.join(", ") : "nothing"}`
  )
}

/** Every captured message, oldest first — the filenames sort by arrival. */
export function readMail(stack: Stack): CapturedMail[] {
  let names: string[]
  try {
    names = readdirSync(stack.mailDir).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }
  return names.sort().flatMap((name) => {
    try {
      return [
        JSON.parse(readFileSync(join(stack.mailDir, name), "utf8")) as CapturedMail,
      ]
    } catch {
      // A file caught mid-write on the next poll.
      return []
    }
  })
}

/**
 * The first URL in a message that points at this deployment.
 *
 * Read out of the **text** part: the HTML one wraps links in markup and an
 * e-mail client would follow either, so the plain one is the smaller thing to
 * parse.
 */
export function linkFrom(mail: CapturedMail, stack: Stack): string {
  const match = new RegExp(`${escapeRegExp(stack.baseURL)}\\S*`, "g").exec(
    mail.text
  )
  if (!match) {
    throw new Error(
      `no ${stack.baseURL} link in the ${mail.template} e-mail:\n${mail.text}`
    )
  }
  // Trailing punctuation from the sentence the link sits in.
  return match[0].replace(/[.,)\]]+$/, "")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
