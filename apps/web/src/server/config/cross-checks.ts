/**
 * Cross-key and cross-file validation.
 *
 * Everything here needs more than one value to decide, so it cannot live in a
 * single zod schema: duplicate ids across a list, a client scope that is not in
 * `oauth.scopes`, an `adminRoles` entry missing from the catalog, a literal
 * secret in a production deployment. All checks run; nothing short-circuits.
 *
 * Warnings are returned alongside the
 * errors — they are logged at startup and never abort it.
 */

import type { ConfigIssue, ConfigWarning } from "./errors"
import { isLocalhostUrl } from "./derive"
import { looksLikeShippedSecret } from "./shipped-defaults"
import { looksPooled } from "../db/client"
import { hasHostTemplate } from "../../lib/client-rules"
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

  // ------------------------------------------------- dynamic issuer --
  // Contradictions that would make `server.dynamicIssuer` silently unsafe or
  // silently dead, refused at boot rather than discovered in production.
  if (config.server.dynamicIssuer) {
    // A warning, not a refusal: the sibling's Dokploy variant turns
    // the flag on before it knows its host at all — the domain is attached
    // after deploy — so requiring the list would refuse the deployment the
    // flag exists for. Unset, every host the trusted edge forwards is
    // followed, which is what the flag always did; this line is how the
    // operator is reminded to close it once the hosts are known.
    if (config.server.allowedHosts === undefined) {
      warnings.push({
        code: "server.dynamic_issuer_unrestricted",
        message:
          '`server.dynamicIssuer` is on and `server.allowedHosts` is not set, so the issuer follows whatever host the trusted edge forwards. Name the hosts this deployment answers for (`["idp.example.com", "*.example.net"]`) as soon as they are known; a request on any other host is then answered as `server.baseUrl` instead of followed.',
      })
    }
    if (config.server.trustProxy === false) {
      issues.push({
        file: "config.json",
        pointer: "/server/dynamicIssuer",
        message:
          "`server.dynamicIssuer` requires `server.trustProxy`. The flag asserts that a trusted edge overwrites X-Forwarded-Host on every hop; with no trusted proxy at all there is no such edge, and the issuer would follow whatever Host a direct caller sent.",
      })
    }
    if (config.server.cookieDomain) {
      issues.push({
        file: "config.json",
        pointer: "/server/cookieDomain",
        message:
          "`server.dynamicIssuer` cannot be combined with `server.cookieDomain`. The dynamic issuer scopes sessions and tokens to the host that minted them; a domain-wide cookie makes a session minted on one host readable across the whole domain, which quietly undoes that scoping.",
      })
    }
  }

  // `*` is a supported value and the only one that removes the check
  // rather than aiming it, so it says so at start-up. A deployment that meant
  // "I do not know my public URL" wants the default — which still checks —
  // and this line is how somebody who copied `*` from an issue thread finds
  // out what they turned off.
  if (config.server.trustedOrigins?.includes("*")) {
    warnings.push({
      code: "server.origin_check_disabled",
      message:
        "`server.trustedOrigins` contains `*`, which switches the CSRF origin check off: any site can post to this IdP with a signed-in visitor's cookies. Leaving the key out is not the same thing — it checks the browser's `Origin` against the address the request arrived on, which needs no configuration and works behind a reverse proxy.",
    })
  }

  // the two other switches that turn a protection off entirely. Each is
  // a legitimate development setting, and each was silent — a deployment
  // could carry either into production and nothing would ever say so. Same
  // severity as the `*` above: the flag is doing what it was set to do, so a
  // refusal would be wrong, and a line at start-up and on the system page is
  // how somebody who copied a dev config finds out what they turned off.
  if (config.server.allowInsecureHttp) {
    warnings.push({
      code: "server.insecure_http_allowed",
      message:
        "`server.allowInsecureHttp` is on: a plain-http `baseUrl` outside localhost is accepted, and with one every session cookie and every credential this IdP handles crosses the wire in clear. Development only — turn it off before anyone but you can reach this deployment.",
    })
  }
  if (!config.rateLimit.enabled) {
    warnings.push({
      code: "ratelimit.disabled",
      message:
        "`rateLimit.enabled` is false: nothing throttles sign-in, password reset, second-factor or token requests, so a password list runs at whatever speed the network allows. Leave it on unless something in front of this process is doing the same job.",
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

  // A shipped default passes every SHAPE check — the reference stack's dev
  // `secret` is 46 characters and arrives through a `${env:…}` placeholder,
  // which is exactly what the production-literal rule below asks for — so the
  // VALUE is checked here, against the known defaults and the markers they
  // carry. A **warning**, never a refusal, and the severity is the point:
  // `isProduction` flips the moment `baseUrl` becomes https, and a boot
  // refusal at that moment would demand rotating `secret` — which logs
  // everyone out and makes the stored signing keys undecryptable. A refusal
  // would turn "insecure but working" into "broken, and the fix destroys the
  // keys". The warning reaches the log at startup and the admin system page.
  if (looksLikeShippedSecret(config.secret)) {
    warnings.push({
      code: "secret.shipped_default",
      message:
        "`secret` looks like a shipped development default. Anyone who reads the public repository can forge sessions and decrypt the stored JWT signing keys. Generate a real one (`openssl rand -base64 48`) — and treat changing it as a key rotation: it signs every session and encrypts the signing keys, so rotating it logs everyone out.",
    })
  }
  for (const [pointer, url] of [
    ["/database/url", config.database.url],
    ["/database/directUrl", config.database.directUrl],
  ] as const) {
    const password = connectionPassword(url)
    if (password === undefined || !looksLikeShippedSecret(password)) continue
    warnings.push({
      code: "database.shipped_default_password",
      message: `The connection string at \`${pointer}\` carries what looks like a shipped default password. Anyone who can reach the database port has whatever access that login grants — change it in the database and in the connection string together.`,
    })
    break // one warning covers both URLs; they carry the same credential
  }

  // -------------------------------------------------------------- database --
  // Only when `url` is actually set: it is optional, and a
  // deployment configured with `directUrl` alone has nothing pooled in it.
  if (
    config.database.url !== undefined &&
    looksPooled(config.database.url) &&
    !config.database.directUrl
  ) {
    warnings.push({
      code: "database.pooled_without_direct_url",
      message:
        "`database.url` looks like a transaction-mode connection pooler. Session advisory locks do not hold through one, so two instances starting together could migrate, reconcile or bootstrap concurrently. Set `database.directUrl` to the direct (non-pooled) endpoint.",
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

  // ------------------------------------------- protected resources (RFC 9728) --
  //
  // Both of these turn a failure that happens at the far end of somebody
  // else's login into a refusal at boot. A scope published in
  // `scopes_supported` is *appended* to what the client already asks for and
  // sent verbatim to `/oauth2/authorize`, so an undeclared one fails the
  // authorization of every client that read the document — a long way from
  // the typo that caused it. And two entries on one path publish two
  // different documents at one URL, where the only thing deciding which one
  // a client gets is the order they happen to be written in.
  const resourcePaths = new Set<string>()
  config.oauth.protectedResources.forEach((resource, index) => {
    if (resourcePaths.has(resource.path)) {
      issues.push({
        file: "config.json",
        pointer: `/oauth/protectedResources/${index}/path`,
        message: `Duplicate protected-resource path \`${resource.path}\`.`,
      })
    }
    resourcePaths.add(resource.path)

    for (const scope of resource.scopes) {
      if (!declaredScopes.has(scope)) {
        issues.push({
          file: "config.json",
          pointer: `/oauth/protectedResources/${index}/scopes`,
          message: `Protected resource \`${resource.path}\` publishes undeclared scope \`${scope}\`, which every client that reads the document would then request and be refused.`,
          hint: "Add it to `oauth.scopes` first, or leave `scopes` empty.",
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

    // the stored form is an unsalted digest, so a placeholder secret is
    // a credential anyone who read the example can present. A warning, like
    // `secret.shipped_default` above and for the same reason: an old
    // development `.env` carries `example-…` for the two example clients and
    // must keep booting. The entropy floor itself is the schema's refusal.
    if (client.clientSecret !== undefined && looksLikeShippedSecret(client.clientSecret)) {
      warnings.push({
        code: "client.shipped_default_secret",
        message: `Client \`${client.clientId}\`'s secret looks like a shipped default or a placeholder (\`example\`, \`change-me\`, …); anyone who read the example can present it. Generate one (\`openssl rand -base64 48\`) and reconcile.`,
      })
    }

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

    // A `{host}` template only means something when the issuer follows the
    // request host. With `dynamicIssuer` off, nothing ever expands it: the
    // client would be registered with a URI no browser can be redirected to,
    // and the first sign-in would fail with an unregistered-redirect error
    // that names a URL the operator never typed. Refused here, where the
    // contradiction is visible.
    if (!config.server.dynamicIssuer) {
      const templated = [
        ...client.redirectUris,
        ...client.postLogoutRedirectUris,
      ].filter(hasHostTemplate)
      if (templated.length > 0) {
        issues.push({
          file: "oauth_clients.json",
          pointer: `/clients/${index}/redirectUris`,
          message: `Client \`${client.clientId}\` uses the \`{host}\` template (${templated.join(", ")}), which is only expanded when \`server.dynamicIssuer\` is on.`,
          hint: "Turn `server.dynamicIssuer` on (read its conditions first), or register the literal URIs.",
        })
      }
    }

    // A first-party app shares the host-only session cookie, so it must sit on
    // the issuer's own origin. A `{host}` template satisfies the
    // rule by construction: it expands to the host of the request being
    // authorized — the same host the host-only session cookie belongs to.
    if (client.firstParty) {
      const issuerOrigin = safeOrigin(config.server.baseUrl)
      const foreign = client.redirectUris.filter(
        (uri) => !hasHostTemplate(uri) && safeOrigin(uri) !== issuerOrigin
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

  // -------------------------------------------------------- gateways (FR-GW) --
  // Every refusal a single entry can produce is in the zod schema, which sees
  // one entry at a time. This is the rule that needs two values: an https
  // issuer minting a bearer token and forwarding it to a plain-http upstream
  // puts that token on the wire in clear. Loopback is exempt because
  // a sidecar on the same host is the ordinary shape and there is no wire.
  for (const [name, target] of Object.entries(config.gateways)) {
    if (!isProduction) continue
    if (!target.url.startsWith("http://")) continue
    if (isLocalhostUrl(target.url)) continue
    warnings.push({
      code: "gateway.insecure_upstream",
      message: `Gateway \`${name}\` forwards to a plain-http upstream (${safeOrigin(target.url) ?? target.url}). The JWT minted from the caller's API key is sent to it in clear, and it is a credential for every resource server that trusts this issuer.`,
    })
  }

  // -------------------------------------------------------------- warnings --
  if (!emailEnabled) {
    warnings.push({
      code: "email.degraded",
      message:
        "No Resend API key configured: password reset, e-mail verification and all notification e-mails are disabled, and `auth.requireEmailVerification` is forced to false.",
    })
  }
  // Self-service sign-up needs e-mail to mean anything: without it nobody's
  // address is verified and nobody can reset a password, so an open sign-up
  // page is an account factory. In production that combination is refused
  // outright (the owner's rule: no self-service registration without
  // e-mail); on a development deployment it stays a warning, because the
  // test harnesses and a laptop open sign-up to create users without a mail
  // provider.
  if (config.signUp.enabled && !emailEnabled) {
    if (isProduction) {
      issues.push({
        file: "config.json",
        pointer: "/signUp/enabled",
        message:
          "Self-service sign-up is on but no e-mail is configured. Without e-mail no address is verified and no password can be reset, so a production deployment does not offer sign-up.",
        hint: "Configure `email.resend.apiKey`, or set `signUp.enabled: false` and create accounts from the admin area.",
      })
    } else if (!config.signUp.requireApproval) {
      warnings.push({
        code: "signup.unverified_open_registration",
        message:
          "Open registration without approval and without e-mail: anyone can create a usable account with an address nobody verified. A production deployment refuses this combination.",
      })
    }
  }
  // Second factors are encrypted with `secret`, not hashed — the TOTP
  // algorithm needs the secret back — so the SQL console, which reads every
  // row, reads them too; with `secret` in hand that is every enrolled
  // factor. Said at start-up whenever both are on, at the owner's request.
  if (config.admin.database !== "disabled" && config.twoFactor.enabled) {
    warnings.push({
      code: "twofactor.readable_by_console",
      message:
        "The SQL console is on and two-factor authentication is enabled: TOTP secrets and backup codes are stored encrypted with `secret`, the console reads every row, and whoever also holds `secret` can decrypt every enrolled second factor.",
    })
  }
  // Social callbacks stay canonical under `dynamicIssuer`: the provider
  // registers ONE callback URL, built from `baseUrl` at boot
  // (`api/routes/sign-in.mjs` hard-codes it from `baseURL`), so social
  // sign-in completes only on the canonical host. Password sign-in follows
  // every host; this says why the Google button works on one of them.
  if (
    config.server.dynamicIssuer &&
    Object.values(config.social).some((provider) => provider.enabled !== false)
  ) {
    warnings.push({
      code: "social.canonical_host_only",
      message:
        "A social provider is enabled together with `server.dynamicIssuer`. Social callbacks are built from `server.baseUrl` and registered with the provider once, so social sign-in works on the canonical host only; other hosts still offer password sign-in.",
    })
  }
  // a social provider enabled while sign-up is off is the normal
  // invite-only deployment and is deliberately not warned about.
  //
  // There is no "no bootstrap admin configured" warning any more. A
  // deployment with no users is not misconfigured — it is new, and it says so
  // itself by serving the first-run setup page.

  return { issues, warnings }
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/** The password component of a connection string, decoded, if it has one. */
function connectionPassword(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const password = new URL(value).password
    if (password === "") return undefined
    try {
      return decodeURIComponent(password)
    } catch {
      return password
    }
  } catch {
    return undefined
  }
}
