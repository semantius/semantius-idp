/**
 * zod schema for `oauth_clients.json` (FR-OIDC-3).
 *
 * The file is the source of truth; startup reconciles it into `oauth_client`
 * (FR-OIDC-2). Unknown fields are rejected. Machine-to-machine clients are not
 * part of v1 (D26): `type: "service"` and a `client_credentials` grant are
 * refused with a message that points at per-user API keys instead.
 */

import { z } from "zod"

import { absoluteUrl, flexArray, flexBoolean } from "../zod-helpers"

export const CLIENT_TYPES = ["web", "spa", "native"] as const
export type ClientType = (typeof CLIENT_TYPES)[number]

/** Public client types cannot keep a secret, so they must use PKCE (FR-OIDC-3). */
export const PUBLIC_CLIENT_TYPES: readonly ClientType[] = ["spa", "native"]

export const SUPPORTED_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
] as const
export const TOKEN_ENDPOINT_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_post",
  "none",
] as const

const clientIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9._~-]+$/,
    "clientId may only contain letters, digits and `. _ ~ -`."
  )

const clientTypeSchema = z.string().superRefine((value, ctx) => {
  if ((CLIENT_TYPES as readonly string[]).includes(value)) return
  if (value === "service") {
    ctx.addIssue({
      code: "custom",
      message:
        '`type: "service"` (machine-to-machine) is not supported in v1. Use a per-user API key and exchange it at `GET {baseUrl}/api/auth/token` instead.',
    })
    return
  }
  ctx.addIssue({
    code: "custom",
    message: `Expected one of ${CLIENT_TYPES.join(", ")}.`,
  })
})

const grantTypeSchema = z.string().superRefine((value, ctx) => {
  if ((SUPPORTED_GRANT_TYPES as readonly string[]).includes(value)) return
  if (value === "client_credentials") {
    ctx.addIssue({
      code: "custom",
      message:
        "The `client_credentials` grant is not supported in v1. Use a per-user API key and exchange it at `GET {baseUrl}/api/auth/token` instead.",
    })
    return
  }
  ctx.addIssue({
    code: "custom",
    message: `Expected one of ${SUPPORTED_GRANT_TYPES.join(", ")}.`,
  })
})

/**
 * A redirect URI must be absolute and exactly matched at authorize time
 * (FR-OIDC-3/4). Wildcards and fragments are rejected outright; plain http is
 * only allowed on loopback, and private-use schemes only for native clients.
 */
function validateRedirectUri(
  value: string,
  type: ClientType,
  fail: (message: string) => void
): void {
  if (value.includes("*")) {
    fail(
      `\`${value}\` must not contain a wildcard; redirect URIs are matched exactly.`
    )
    return
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(`\`${value}\` is not an absolute URI.`)
    return
  }
  if (url.hash !== "" || value.includes("#")) {
    fail(`\`${value}\` must not contain a fragment.`)
    return
  }
  if (url.protocol === "https:") return
  if (url.protocol === "http:") {
    const isLoopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]"
    if (!isLoopback) {
      fail(
        `\`${value}\` must use https; plain http is only allowed on loopback (http://127.0.0.1, http://localhost).`
      )
    }
    return
  }
  if (type === "native") return // private-use scheme, e.g. com.example.app:/callback
  fail(
    `\`${value}\` uses a private-use scheme, which is only allowed for \`type: "native"\` clients.`
  )
}

const baseClientSchema = z.strictObject({
  clientId: clientIdSchema,
  name: z.string().min(1).optional(),
  type: clientTypeSchema,
  clientSecret: z
    .string()
    .optional()
    .describe(
      "Confidential (`web`) clients only. Use a `${env:…}` placeholder; ≥ 32 characters."
    ),
  tokenEndpointAuthMethod: z.enum(TOKEN_ENDPOINT_AUTH_METHODS).optional(),
  firstParty: flexBoolean()
    .default(false)
    .describe(
      "Same-host app that may use the session-JWT endpoint (FR-OIDC-14)."
    ),
  redirectUris: flexArray(z.string().min(1)).default([]),
  postLogoutRedirectUris: flexArray(z.string().min(1)).default([]),
  scopes: flexArray(z.string().min(1))
    .optional()
    .describe("Must be a subset of `oauth.scopes`."),
  audience: z
    .union([absoluteUrl(), flexArray(absoluteUrl(), { min: 1 })])
    .optional()
    .describe(
      "Per-client default audience; overrides `jwt.audience` for this client (FR-OIDC-6)."
    ),
  grantTypes: flexArray(grantTypeSchema).optional(),
  responseTypes: flexArray(z.literal("code")).optional(),
  requirePKCE: flexBoolean().default(true),
  skipConsent: flexBoolean()
    .default(true)
    .describe(
      "File clients were configured by an admin, so consent is skipped by default."
    ),
  enableEndSession: flexBoolean()
    .default(true)
    .describe("Requires at least one `postLogoutRedirectUris` entry."),
  resourceServer: flexBoolean()
    .default(false)
    .describe(
      "May introspect tokens it is an audience for, not only its own (FR-OIDC-4)."
    ),
  disabled: flexBoolean().default(false),
  uri: absoluteUrl().optional(),
  icon: z.string().optional(),
  contacts: flexArray(z.string().min(1)).default([]),
  tos: absoluteUrl().optional(),
  policy: absoluteUrl().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const clientSchema = baseClientSchema.superRefine((client, ctx) => {
  const type = client.type as ClientType
  const isPublic = PUBLIC_CLIENT_TYPES.includes(type)

  if (isPublic && client.clientSecret !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["clientSecret"],
      message: `A \`${type}\` client is public and must not carry a client secret.`,
    })
  }
  if (
    !isPublic &&
    (client.clientSecret === undefined || client.clientSecret === "")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["clientSecret"],
      message:
        "A `web` client is confidential and requires a `clientSecret` (use a `${env:…}` placeholder).",
    })
  }
  if (client.clientSecret !== undefined && client.clientSecret.length < 32) {
    ctx.addIssue({
      code: "custom",
      path: ["clientSecret"],
      message: "Client secrets must be at least 32 characters.",
    })
  }
  if (
    isPublic &&
    client.tokenEndpointAuthMethod !== undefined &&
    client.tokenEndpointAuthMethod !== "none"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["tokenEndpointAuthMethod"],
      message: `A \`${type}\` client is public; its token endpoint auth method must be "none".`,
    })
  }
  if (!isPublic && client.tokenEndpointAuthMethod === "none") {
    ctx.addIssue({
      code: "custom",
      path: ["tokenEndpointAuthMethod"],
      message:
        'A `web` client is confidential; "none" is not a valid token endpoint auth method for it.',
    })
  }
  if (isPublic && client.requirePKCE === false) {
    ctx.addIssue({
      code: "custom",
      path: ["requirePKCE"],
      message: `PKCE is mandatory for public (\`${type}\`) clients.`,
    })
  }
  if (client.redirectUris.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["redirectUris"],
      message:
        "At least one redirect URI is required — every v1 client uses the authorization-code flow.",
    })
  }
  client.redirectUris.forEach((uri, index) => {
    validateRedirectUri(uri, type, (message) =>
      ctx.addIssue({ code: "custom", path: ["redirectUris", index], message })
    )
  })
  client.postLogoutRedirectUris.forEach((uri, index) => {
    validateRedirectUri(uri, type, (message) =>
      ctx.addIssue({
        code: "custom",
        path: ["postLogoutRedirectUris", index],
        message,
      })
    )
  })
  if (client.enableEndSession && client.postLogoutRedirectUris.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["postLogoutRedirectUris"],
      message:
        "`enableEndSession` requires at least one post-logout redirect URI (set `enableEndSession: false` to opt out).",
    })
  }
})

export const clientsFileSchema = z.strictObject({
  clients: z.array(clientSchema).default([]),
})

export type ClientEntry = z.infer<typeof clientSchema>
export type ClientsFile = z.infer<typeof clientsFileSchema>
