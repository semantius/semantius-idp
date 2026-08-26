/**
 * In-memory config folder used by the unit tests.
 *
 * `makeConfigFolder()` returns a valid, minimal three-file folder plus a
 * `readFile` implementation that {@link loadConfig} can be pointed at, so a test
 * only states the one thing it is about.
 */

export interface ConfigFolder {
  files: Record<string, string>
  readFile: (path: string) => string
}

export const VALID_SECRET = "0123456789abcdef0123456789abcdef0123456789"

export interface MakeConfigFolderOptions {
  dir?: string
  config?: Record<string, unknown>
  clients?: Record<string, unknown> | null
  roles?: Record<string, unknown> | null
  /**
   * Which spelling the folder is written in (**D60**). The default is `json`
   * on purpose: the fallback is the path a folder written before D60 takes,
   * and leaving the whole suite on it keeps that path exercised by everything
   * rather than by one test.
   */
  extension?: "json" | "jsonc"
  /** Extra files addressable through `${file:…}` placeholders. */
  extraFiles?: Record<string, string>
}

export function baseConfig(): Record<string, unknown> {
  return {
    server: { baseUrl: "http://localhost:3000" },
    secret: VALID_SECRET,
    database: { url: "postgres://idp:idp@localhost:5432/idp" },
    site: { name: "Test IdP" },
    jwt: { audience: "http://localhost:3000" },
  }
}

export function makeConfigFolder(
  options: MakeConfigFolderOptions = {}
): ConfigFolder {
  const dir = options.dir ?? "/config"
  const ext = options.extension ?? "json"
  const files: Record<string, string> = { ...options.extraFiles }

  files[`${dir}/config.${ext}`] = JSON.stringify(
    options.config ?? baseConfig(),
    null,
    2
  )
  if (options.clients !== null) {
    files[`${dir}/oauth_clients.${ext}`] = JSON.stringify(
      options.clients ?? { clients: [] },
      null,
      2
    )
  }
  if (options.roles !== null) {
    files[`${dir}/roles.${ext}`] = JSON.stringify(
      options.roles ?? {
        roles: [{ name: "admin" }, { name: "user", default: true }],
      },
      null,
      2
    )
  }

  return {
    files,
    readFile: (path: string) => {
      const normalized = path.replace(/\\/g, "/")
      const content = files[normalized]
      if (content === undefined) throw new Error(`ENOENT: ${normalized}`)
      return content
    },
  }
}

/** A confidential web client that passes every FR-OIDC-3 rule. */
export function webClient(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    clientId: "web-app",
    name: "Web App",
    type: "web",
    clientSecret: "s".repeat(40),
    redirectUris: ["https://app.example.com/callback"],
    postLogoutRedirectUris: ["https://app.example.com/"],
    ...overrides,
  }
}

/** A public SPA client that passes every FR-OIDC-3 rule. */
export function spaClient(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    clientId: "spa-app",
    name: "SPA",
    type: "spa",
    redirectUris: ["https://spa.example.com/callback"],
    enableEndSession: false,
    ...overrides,
  }
}
