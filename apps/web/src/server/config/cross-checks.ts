/**
 * Cross-key and cross-file validation (CFG-5).
 *
 * Everything here needs more than one value to decide, so it cannot live in a
 * single zod schema: duplicate ids across a list, a client scope that is not in
 * `oauth.scopes`, an `adminRoles` entry missing from the catalog, a literal
 * secret in a production deployment. All checks run; nothing short-circuits.
 *
 * Warnings (FR-SIGNUP-4, FR-MAIL-1/2, FR-ADMIN-1) are returned alongside the
 * errors — they are logged at startup and never abort it.
 */

import type { ConfigIssue, ConfigWarning } from "./errors"
import { isLocalhostUrl } from "./derive"
import {
  RESERVED_CLAIM_NAMES,
  REJECTED_ENTRA_TENANTS,
} from "./schema/config-schema"
import type { ConfigFile } from "./schema/config-schema"
import type { ClientEntry } from "./schema/clients-schema"
import type { RoleEntry } from "./schema/roles-schema"

export interface CrossCheckInput {
  config: ConfigFile
  clients: readonly ClientEntry[]
  roles: readonly RoleEntry[]
  /**
   * Pointers whose value came entirely from a `${env:…}` / `${file:…}`
   * placeholder, per file. Used by the production-literal-secret rule.
   */
  placeholderPointers: {
    config: ReadonlySet<string>
    clients: ReadonlySet<string>
  }
}

export interface CrossCheckResult {
  issues: ConfigIssue[]
  warnings: ConfigWarning[]
}

export function runCrossChecks(input: CrossCheckInput): CrossCheckResult {
  const issues: ConfigIssue[] = []
  const warnings: ConfigWarning[] = []
  const { config, clients, roles, placeholderPointers } = input

  const isProduction = config.server.baseUrl.startsWith("https://")
  const emailEnabled = Boolean(config.email.resend.apiKey)

  // ---------------------------------------------------------------- server --
  if (
    !isProduction &&
    !isLocalhostUrl(config.server.baseUrl) &&
    !config.server.allowInsecureHttp
  ) {
    issues.push({
      file: "config.json",
      pointer: "/server/baseUrl",
      message: "A non-https baseUrl outside localhost is refused.",
      hint: "Terminate TLS in front of the container, or set `server.allowInsecureHttp: true` for local development only.",
    })
  }
  if (config.server.baseUrl.endsWith("/")) {
    issues.push({
      file: "config.json",
      pointer: "/server/baseUrl",
      message:
        "The issuer must not end with a trailing slash — `iss` is compared byte-for-byte.",
    })
  }

  // ---------------------------------------------------------------- secret --
  if (config.secret.length < 32) {
    issues.push({
      file: "config.json",
      pointer: "/secret",
      message: "`secret` must be at least 32 characters (32 random bytes).",
      hint: "Generate one with `openssl rand -base64 48`.",
    })
  }

  // ------------------------------------------------------------------ auth --
  if (config.auth.password.minLength > config.auth.password.maxLength) {
    issues.push({
      file: "config.json",
      pointer: "/auth/password/minLength",
      message:
        "`auth.password.minLength` cannot exceed `auth.password.maxLength`.",
    })
  }

  // ----------------------------------------------------------------- email --
  if (emailEnabled && !config.email.from) {
    issues.push({
      file: "config.json",
      pointer: "/email/from",
      message:
        "`email.from` is required whenever a Resend API key is configured.",
    })
  }

  // ------------------------------------------------------------------- jwt --
  for (const claim of Object.keys(config.jwt.claims)) {
    if ((RESERVED_CLAIM_NAMES as readonly string[]).includes(claim)) {
      issues.push({
        file: "config.json",
        pointer: `/jwt/claims/${claim}`,
        message: `\`${claim}\` is a reserved claim and cannot be set from \`jwt.claims\`.`,
        hint: `Reserved: ${RESERVED_CLAIM_NAMES.join(", ")}.`,
      })
    }
  }

  // ----------------------------------------------------------------- oauth --
  const declaredScopes = new Set(config.oauth.scopes)
  if (!declaredScopes.has("openid")) {
    issues.push({
      file: "config.json",
      pointer: "/oauth/scopes",
      message:
        "`oauth.scopes` must include `openid` — every v1 flow is an OIDC flow.",
    })
  }
  if (config.oauth.refreshTokenTtl > config.oauth.refreshTokenMaxLifetime) {
    issues.push({
      file: "config.json",
      pointer: "/oauth/refreshTokenTtl",
      message:
        "`oauth.refreshTokenTtl` (sliding) cannot exceed `oauth.refreshTokenMaxLifetime` (absolute).",
    })
  }
  config.oauth.resources.forEach((resource, index) => {
    if (typeof resource === "string") return
    for (const scope of resource.allowedScopes ?? []) {
      if (!declaredScopes.has(scope)) {
        issues.push({
          file: "config.json",
          pointer: `/oauth/resources/${index}/allowedScopes`,
          message: `Resource \`${resource.identifier}\` allows undeclared scope \`${scope}\`.`,
          hint: "Add it to `oauth.scopes` first.",
        })
      }
    }
  })

  // ---------------------------------------------------------------- social --
  for (const [providerId, provider] of Object.entries(config.social)) {
    if (providerId === "microsoft") {
      const tenantId =
        typeof provider.tenantId === "string" ? provider.tenantId.trim() : ""
      if (tenantId === "") {
        issues.push({
          file: "config.json",
          pointer: "/social/microsoft/tenantId",
          message:
            "`social.microsoft.tenantId` is required — a tenant GUID or a verified tenant domain.",
        })
      } else if (
        (REJECTED_ENTRA_TENANTS as readonly string[]).includes(
          tenantId.toLowerCase()
        )
      ) {
        issues.push({
          file: "config.json",
          pointer: "/social/microsoft/tenantId",
          message: `\`${tenantId}\` is not a tenant. Pin a single tenant so identities cannot come from anywhere.`,
          hint: `Rejected values: ${REJECTED_ENTRA_TENANTS.join(", ")}.`,
        })
      }
    }
  }

  // ----------------------------------------------------------------- roles --
  const roleNames = new Set<string>()
  roles.forEach((role, index) => {
    if (roleNames.has(role.name)) {
      issues.push({
        file: "roles.json",
        pointer: `/roles/${index}/name`,
        message: `Duplicate role \`${role.name}\`.`,
      })
    }
    roleNames.add(role.name)
  })
  const defaultRoles = roles.filter((role) => role.default)
  if (defaultRoles.length === 0) {
    issues.push({
      file: "roles.json",
      pointer: "/roles",
      message:
        "Exactly one role must set `default: true` — it is assigned at self-registration.",
    })
  } else if (defaultRoles.length > 1) {
    issues.push({
      file: "roles.json",
      pointer: "/roles",
      message: `Exactly one role may set \`default: true\`; found ${defaultRoles.length} (${defaultRoles
        .map((role) => role.name)
        .join(", ")}).`,
    })
  }
  config.admin.adminRoles.forEach((role, index) => {
    if (!roleNames.has(role)) {
      issues.push({
        file: "config.json",
        pointer: `/admin/adminRoles/${index}`,
        message: `\`${role}\` is not in the role catalog.`,
        hint: "Add it to roles.json, or point `admin.adminRoles` at an existing role.",
      })
    }
  })

  // --------------------------------------------------------------- clients --
  const clientIds = new Set<string>()
  clients.forEach((client, index) => {
    if (clientIds.has(client.clientId)) {
      issues.push({
        file: "oauth_clients.json",
        pointer: `/clients/${index}/clientId`,
        message: `Duplicate clientId \`${client.clientId}\`.`,
      })
    }
    clientIds.add(client.clientId)

    for (const scope of client.scopes ?? []) {
      if (!declaredScopes.has(scope)) {
        issues.push({
          file: "oauth_clients.json",
          pointer: `/clients/${index}/scopes`,
          message: `Client \`${client.clientId}\` references undeclared scope \`${scope}\`.`,
          hint: `Declared scopes: ${config.oauth.scopes.join(", ")}.`,
        })
      }
    }

    // A first-party app shares the host-only session cookie, so it must sit on
    // the issuer's own origin (FR-OIDC-14).
    if (client.firstParty) {
      const issuerOrigin = safeOrigin(config.server.baseUrl)
      const foreign = client.redirectUris.filter(
        (uri) => safeOrigin(uri) !== issuerOrigin
      )
      if (foreign.length > 0) {
        issues.push({
          file: "oauth_clients.json",
          pointer: `/clients/${index}/firstParty`,
          message: `\`firstParty\` requires every redirect URI to be on the issuer origin (${issuerOrigin}); ${foreign.join(", ")} is not.`,
          hint: "Apps on other hosts are not first-party — they use the ordinary OIDC flow.",
        })
      }
    }
  })

  // ------------------------------------------- production literal secrets ---
  if (isProduction) {
    const literal = (
      file: "config.json" | "oauth_clients.json",
      pointer: string,
      value: string | undefined,
      label: string
    ) => {
      if (!value) return
      const pointers =
        file === "config.json"
          ? placeholderPointers.config
          : placeholderPointers.clients
      if (pointers.has(pointer)) return
      issues.push({
        file,
        pointer,
        message: `${label} is a literal value in a production deployment.`,
        hint: "Use a `${env:NAME}` or `${file:/run/secrets/…}` placeholder so the secret never lives in a config file.",
      })
    }

    literal("config.json", "/secret", config.secret, "`secret`")
    literal(
      "config.json",
      "/email/resend/apiKey",
      config.email.resend.apiKey,
      "The Resend API key"
    )
    for (const [providerId, provider] of Object.entries(config.social)) {
      literal(
        "config.json",
        `/social/${providerId}/clientSecret`,
        typeof provider.clientSecret === "string"
          ? provider.clientSecret
          : undefined,
        `The \`${providerId}\` client secret`
      )
    }
    clients.forEach((client, index) => {
      literal(
        "oauth_clients.json",
        `/clients/${index}/clientSecret`,
        client.clientSecret,
        `The client secret of \`${client.clientId}\``
      )
    })
  }

  // -------------------------------------------------------------- warnings --
  if (!emailEnabled) {
    warnings.push({
      code: "email.degraded",
      message:
        "No Resend API key configured: password reset, e-mail verification and all notification e-mails are disabled, and `auth.requireEmailVerification` is forced to false (FR-MAIL-2).",
    })
  }
  if (
    config.signUp.enabled &&
    !config.signUp.requireApproval &&
    !emailEnabled
  ) {
    warnings.push({
      code: "signup.unverified_open_registration",
      message:
        "Open registration without approval and without e-mail: anyone can create a usable account with an address nobody verified.",
    })
  }
  // D25: a social provider enabled while sign-up is off is the normal
  // invite-only deployment and is deliberately not warned about.
  const bootstrap = config.admin.bootstrap
  if (
    !bootstrap ||
    bootstrap.email.trim() === "" ||
    bootstrap.password === ""
  ) {
    warnings.push({
      code: "admin.bootstrap_skipped",
      message:
        "No bootstrap admin configured: if the database holds no admin yet, nobody can sign in. Set `admin.bootstrap`, or create one with `idp create-admin`.",
    })
  }

  return { issues, warnings }
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}
