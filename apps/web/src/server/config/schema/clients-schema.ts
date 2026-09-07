/**
 * zod schema for `oauth_clients.jsonc`.
 *
 * The file is the source of truth; startup reconciles it into `oauth_client`
 *. Unknown fields are rejected. Machine-to-machine clients are not
 * part of v1: `type: "service"` and a `client_credentials` grant are
 * refused with a message that points at per-user API keys instead.
 */

import { z } from "zod"

import { absoluteUri, absoluteUrl, flexArray, flexBoolean } from "../zod-helpers"
import {
  CLIENT_TYPES,
  PUBLIC_CLIENT_TYPES,
  checkRedirectUri,
  isReservedClientId,
} from "@/lib/client-rules"
import type { ClientType } from "@/lib/client-rules"

/**
 * The entropy floor for a file-declared secret: a 32-character hex
 * secret — the shortest a generator writes — falls under it once in thirty
 * million draws, and a placeholder never reaches it.
 */
const MIN_DISTINCT_SECRET_CHARACTERS = 8

// The rules themselves live in `lib/client-rules.ts`, because `/admin/clients`
// applies the same ones in the browser and importing this module there would
// put zod in the client bundle. Re-exported so every existing caller
// of `server/config` is unchanged.
export { CLIENT_TYPES, PUBLIC_CLIENT_TYPES }
export type { ClientType }

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
  // `.` and `..` pass the character rule and are not usable as a
  // path segment — `/admin/clients/<id>/edit` is the row's own address, and a
  // browser resolves `/admin/clients/../edit` before the request leaves it.
  // Two exact values, not a rule about dots: `com.example.app` is ordinary.
  .refine((value) => !isReservedClientId(value), {
    message: "clientId may not be `.` or `..`.",
  })

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
 * The operator-facing wording for what {@link checkRedirectUri} decided.
 *
 * The decision is shared with the browser; only the sentence is here, because
 * this one goes into a startup failure an operator reads in a log and the
 * other goes through the message catalog.
 */
function validateRedirectUri(
  value: string,
  type: ClientType,
  fail: (message: string) => void
): void {
  const problem = checkRedirectUri(value, type)
  if (!problem) return
  switch (problem) {
    case "wildcard":
      fail(
        `\`${value}\` must not contain a wildcard; redirect URIs are matched exactly.`
      )
      return
    case "not_absolute":
      fail(`\`${value}\` is not an absolute URI.`)
      return
    case "fragment":
      fail(`\`${value}\` must not contain a fragment.`)
      return
    case "http_not_loopback":
      fail(
        `\`${value}\` must use https; plain http is only allowed on loopback (http://127.0.0.1, http://localhost).`
      )
      return
    case "private_scheme":
      fail(
        `\`${value}\` uses a private-use scheme, which is only allowed for \`type: "native"\` clients.`
      )
      return
    case "host_template":
      fail(
        `\`${value}\` misuses the \`{host}\` template: it must stand for the entire host component, exactly once — \`https://{host}/callback\` — with no credentials and no port of its own.`
      )
      return
  }
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
      "Same-host app that may use the session-JWT endpoint."
    ),
  redirectUris: flexArray(z.string().min(1)).default([]),
  postLogoutRedirectUris: flexArray(z.string().min(1)).default([]),
  scopes: flexArray(z.string().min(1))
    .optional()
    .describe("Must be a subset of `oauth.scopes`."),
  audience: z
    .union([absoluteUri(), flexArray(absoluteUri(), { min: 1 })])
    .optional()
    .describe(
      "Per-client default audience; overrides `jwt.audience` for this client."
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
      "May introspect tokens it is an audience for, not only its own."
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
  } else if (client.clientSecret !== undefined) {
    // the stored form is an unsalted SHA-256 (reconciliation and
    // the token endpoint share one function, and that equality is what makes
    // a file-declared secret work at all), so a secret's entropy is the only
    // thing between a database dump and a working credential. Length alone
    // let `ssss…` and a copied example through. Two shape checks that a
    // generator always passes: a 32-character hex secret — the shortest
    // `openssl rand -hex 16` — has fewer than eight distinct characters once
    // in thirty million draws. The marker words a placeholder is written
    // with (`example`, `change-me`, …) are a start-up WARNING in
    // `cross-checks.ts`, not a refusal here: a development `.env` copied from
    // `.env.example` before the generator carries them for the two example clients,
    // and a boot refusal would turn a working checkout into one that does not
    // start, over a placeholder that redirects to nobody's deployment.
    if (new Set(client.clientSecret).size < MIN_DISTINCT_SECRET_CHARACTERS) {
      ctx.addIssue({
        code: "custom",
        path: ["clientSecret"],
        message: `Client secrets must look generated: at least ${MIN_DISTINCT_SECRET_CHARACTERS} distinct characters (\`openssl rand -base64 48\`).`,
      })
    }
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
