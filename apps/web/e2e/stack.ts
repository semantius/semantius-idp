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
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..")

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

/** The bootstrap administrator every stack starts with (FR-ADMIN-1). */
export const ADMIN = {
  email: "e2e-admin@example.com",
  /** Consumed by the forced change at first sign-in. */
  bootstrapPassword: "e2e-bootstrap-password-01",
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
    IDP_SECRETS_DIR: join(stack.workDir, "secrets"),
    IDP_MAIL_HOST_DIR: stack.mailDir,
    POSTGRES_PASSWORD: PG_PASSWORD,
    IDP_SECRET: SECRET,
    // `:80` rather than a hostname: a catch-all HTTP site. Given `localhost`
    // Caddy would issue an internal certificate, listen on 443 and redirect —
    // and the test talks plain HTTP to a published port under a different
    // Host header, so it would follow that redirect to nowhere.
    IDP_DOMAIN: ":80",
  }
}

/** The base file plus the e2e overlay — see `docker-compose.e2e.yml`. */
const COMPOSE_FILES = [
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.e2e.yml",
]

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
  const secretsDir = join(stack.workDir, "secrets")
  mkdirSync(configDir, { recursive: true })
  mkdirSync(secretsDir, { recursive: true })
  mkdirSync(stack.mailDir, { recursive: true })
  writeFileSync(join(secretsDir, "postgres_password"), PG_PASSWORD)

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
        admin: {
          bootstrap: {
            email: ADMIN.email,
            password: ADMIN.bootstrapPassword,
            name: "E2E Admin",
          },
        },
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

/** Brings the stack up and waits for `/readyz`. Throws with the logs on failure. */
export async function startStack(stack: Stack): Promise<void> {
  writeConfig(stack)
  const env = composeEnv(stack)
  const profile = stack.basePath === "" ? [] : ["--profile", "caddy"]

  docker(
    [
      "compose",
      ...COMPOSE_FILES,
      "-p",
      stack.project,
      ...profile,
      "down",
      "-v",
      "--remove-orphans",
    ],
    env
  )
  const up = docker(
    [
      "compose",
      ...COMPOSE_FILES,
      "-p",
      stack.project,
      ...profile,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
    ],
    env
  )
  if (up.code !== 0) {
    throw new Error(
      `stack ${stack.project} did not come up:\n${up.stderr}\n${logs(stack)}`
    )
  }

  const ready = await waitForReady(stack)
  if (!ready) {
    throw new Error(
      `stack ${stack.project} never became ready:\n${logs(stack)}`
    )
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
  const profile = stack.basePath === "" ? [] : ["--profile", "caddy"]
  const restarted = docker(
    [
      "compose",
      ...COMPOSE_FILES,
      "-p",
      stack.project,
      ...profile,
      "restart",
      "idp",
    ],
    composeEnv(stack)
  )
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
  const result = docker(
    [
      "compose",
      ...COMPOSE_FILES,
      "-p",
      stack.project,
      "logs",
      "--no-color",
      "--tail",
      "120",
    ],
    composeEnv(stack)
  )
  return result.stdout
}

export function stopStack(stack: Stack): void {
  docker(
    [
      "compose",
      ...COMPOSE_FILES,
      "-p",
      stack.project,
      "--profile",
      "caddy",
      "down",
      "-v",
      "--remove-orphans",
    ],
    composeEnv(stack)
  )
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
