/**
 * Social providers from configuration alone (FR-SOC-1..5).
 *
 * Any Better Auth built-in provider id may appear under `config.json →
 * social.<providerId>`; the IdP does not maintain its own list, so enabling a
 * provider is a config change and nothing else. A provider absent from the
 * config renders no button and its callback route is inert, because Better Auth
 * only registers the ones handed to it here.
 *
 * Two rules are enforced beyond passing options through:
 *
 * - **`disableImplicitSignUp`** whenever `signUp.enabled` is false, so social
 *   sign-in succeeds only for identities that already exist (FR-SIGNUP-1).
 * - **`given_name` / `family_name` → `firstName` / `lastName`** (FR-SIGNUP-5).
 *
 * Account linking is *not* configured here: it is disabled globally in the core
 * options (FR-SOC-2), which is what makes `(providerId, accountId)` the only
 * identity.
 */

import type { IdpConfig } from "../../config/derive"
import type { SocialProviderConfig } from "../../config/schema/config-schema"

/** Keys the IdP consumes itself and must not forward to the provider. */
const IDP_OWNED_KEYS = new Set([
  "enabled",
  "syncProfile",
  "allowedEmailDomains",
])

interface MappedProfileNames {
  firstName?: string
  lastName?: string
}

/**
 * Providers put the given/family name in different places; every OIDC provider
 * that returns them uses the standard claim names, which covers Google, Entra
 * and the rest. GitHub has only `name`, so the split is left to the sign-up
 * form.
 */
export function mapProfileNames(
  profile: Record<string, unknown>
): MappedProfileNames {
  const given = profile.given_name ?? profile.givenName
  const family = profile.family_name ?? profile.familyName ?? profile.surname
  return {
    ...(typeof given === "string" && given !== "" ? { firstName: given } : {}),
    ...(typeof family === "string" && family !== ""
      ? { lastName: family }
      : {}),
  }
}

/**
 * Builds the `socialProviders` option. Returns `undefined` when nothing is
 * configured, so Better Auth registers no social routes at all.
 */
export function buildSocialProviders(
  config: IdpConfig
): Record<string, Record<string, unknown>> | undefined {
  const entries = Object.entries(config.file.social).filter(
    ([, provider]) => provider.enabled
  )
  if (entries.length === 0) return undefined

  const providers: Record<string, Record<string, unknown>> = {}

  for (const [providerId, provider] of entries) {
    providers[providerId] = {
      ...passthroughOptions(provider),
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,

      // FR-SIGNUP-1: with sign-up off, an unknown identity is refused rather
      // than silently registered.
      ...(config.file.signUp.enabled ? {} : { disableImplicitSignUp: true }),

      // FR-SOC-4: `syncProfile` is what Better Auth calls
      // `overrideUserInfoOnSignIn` — with it off the provider's profile is
      // read once at registration and never again. Nothing used to set it,
      // so the documented default of `true` silently did nothing.
      overrideUserInfoOnSignIn: provider.syncProfile,

      // FR-SIGNUP-5 / FR-SOC-4: name mapping, applied on create and on sync.
      mapProfileToUser: (profile: Record<string, unknown>) =>
        mapProfileNames(profile),
    }
  }

  return providers
}

/** Everything the operator wrote that is a provider option, e.g. `tenantId`, `prompt`, `scope`. */
function passthroughOptions(
  provider: SocialProviderConfig
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(provider)) {
    if (IDP_OWNED_KEYS.has(key)) continue
    if (key === "clientId" || key === "clientSecret") continue
    if (value === undefined) continue
    result[key] = value
  }
  return result
}

/**
 * Whether a provider-supplied e-mail is allowed to register (FR-SOC-3 with
 * FR-SIGNUP-3, plus the per-provider `allowedEmailDomains` of FR-SOC-1).
 * An empty list means no restriction.
 */
export function isEmailDomainAllowed(
  email: string,
  allowedDomains: readonly string[]
): boolean {
  if (allowedDomains.length === 0) return true
  const at = email.lastIndexOf("@")
  if (at === -1) return false
  const domain = email.slice(at + 1).toLowerCase()
  return allowedDomains.some((allowed) => allowed.toLowerCase() === domain)
}

/** Trimmed and lower-cased, everywhere an address is handled (FR-AUTH-1). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
