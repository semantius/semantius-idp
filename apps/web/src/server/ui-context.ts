/**
 * The configuration the public pages are allowed to know about.
 *
 * Route loaders send this to the browser, so it must contain nothing an
 * anonymous visitor should not see: no secrets, no client secrets, no
 * connection strings — only the capability flags that decide which controls
 * render at all.
 *
 * Hiding a control is a real requirement, not cosmetics: with e-mail off,
 * "forgot password" must not exist (FR-MAIL-2), and with sign-up off, `/signup`
 * returns 404 and is unlinked (FR-SIGNUP-1).
 */

import type { IdpConfig } from "./config/derive"
import { createBasePaths } from "./oidc/base-path"
import type { BasePaths } from "./oidc/base-path"

export interface SocialProviderView {
  id: string
  /** Human label for the button, e.g. `Google`. */
  label: string
}

export interface UiContext {
  siteName: string
  /**
   * What `/admin/*` calls itself (**D61**). `site.adminTitle` when it is set,
   * `site.name` otherwise, so nothing has to test for the fallback. It is the
   * one surface that gets its own name: an operator whose colleagues know the
   * deployment as "User Manager" says so once, and the sign-in page, the
   * account area and every e-mail still carry the identity provider's name.
   */
  adminTitle: string
  logo?: string
  /**
   * `<link rel="icon">`. Always set, and always mount-path-absolute: without
   * it a browser falls back to probing `/favicon.ico` at the *origin* root,
   * which under a sub-path deployment is somebody else's application (spike
   * S3 caught the 404).
   */
  favicon: string
  theme: "system" | "light" | "dark"
  supportEmail?: string
  termsUrl?: string
  privacyUrl?: string
  locale: string

  /** Prefix every in-app link with this so a sub-path deployment works (OPS-10). */
  basePath: string

  /** FR-SIGNUP-1: with sign-up off there is no link and no page. */
  signUpEnabled: boolean
  /** FR-SIGNUP-2: shown as a notice on the sign-up form. */
  requireApproval: boolean
  /** FR-MAIL-2: gates reset, verification and change-e-mail across the UI. */
  emailEnabled: boolean
  /** FR-AUTH-2: whether an unverified account can sign in. */
  requireEmailVerification: boolean
  /** FR-2FA-1. */
  twoFactorEnabled: boolean
  /**
   * `twoFactor.trustDeviceDays`. Zero means "always ask", and the challenge
   * page then offers no trust-this-device checkbox at all rather than one
   * that would do nothing.
   */
  twoFactorTrustDeviceDays: number
  /** FR-KEY-1. */
  apiKeysEnabled: boolean
  /** `apiKeys.maxExpiresIn` in whole days, which is how the form asks for it. */
  apiKeyMaxExpiresInDays: number
  /** Minimum password length, shown as an inline policy hint (FR-ACCT-2). */
  passwordMinLength: number
  /**
   * FR-ADMIN-5. With impersonation off the control is **not rendered**.
   *
   * This reverses an earlier deliberate choice — a disabled, explained button,
   * on the argument that a vanishing control reads as a missing feature. The
   * owner, walking the running application on 2026-08-25, read it the other
   * way: a permanently dead button beside eight live ones is clutter, and the
   * operator who turned the option off already knows why it is gone.
   * FR-ADMIN-5 never required the control to be visible.
   */
  allowImpersonation: boolean
  /**
   * FR-ADMIN-7: whether `/admin/database` exists at all.
   *
   * A boolean, not the tri-state itself. Which of `read-only` and `read-write`
   * a deployment runs decides whether the console shows a write toggle, and
   * that is administrator-facing detail -- this object reaches every anonymous
   * visitor of the sign-in page, so it carries "there is a database console"
   * and stops there. The mode comes back from `/idp/database/schema`, behind
   * the admin gate, which is also where the nav entry and the route get their
   * answer from.
   */
  adminDatabaseEnabled: boolean
  /**
   * `oauth.scopes` — every scope a client may be registered with (FR-OIDC-3).
   *
   * Public information: they are already in the discovery document, and the
   * admin client form needs them to render its checkboxes. The endpoint
   * re-checks the list, so this decides which boxes exist and nothing else.
   */
  oauthScopes: string[]
  /** FR-SOC-1: only providers that are actually configured render a button. */
  socialProviders: SocialProviderView[]
}

/** Provider ids Better Auth ships, with the capitalisation their brand uses. */
const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  gitlab: "GitLab",
  apple: "Apple",
  discord: "Discord",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  spotify: "Spotify",
  twitch: "Twitch",
  twitter: "X",
  dropbox: "Dropbox",
  kick: "Kick",
  reddit: "Reddit",
  roblox: "Roblox",
  tiktok: "TikTok",
  vk: "VK",
  zoom: "Zoom",
  notion: "Notion",
  salesforce: "Salesforce",
  slack: "Slack",
  linear: "Linear",
  figma: "Figma",
  huggingface: "Hugging Face",
  atlassian: "Atlassian",
  cognito: "Cognito",
  paypal: "PayPal",
  line: "LINE",
  naver: "Naver",
  kakao: "Kakao",
}

function labelFor(providerId: string): string {
  return (
    PROVIDER_LABELS[providerId] ??
    providerId.charAt(0).toUpperCase() + providerId.slice(1)
  )
}

/**
 * Turns a `site.logo` / `site.favicon` setting into a URL the browser can use.
 *
 * The setting names a file inside the config folder's `branding/` directory
 * (CFG-1), which `routes/branding.$.ts` serves at `/branding/*`. Prefixing the
 * result with the mount path is not cosmetic: a bare `logo.svg` resolves
 * against whatever page is showing, and `/favicon.ico` resolves against the
 * *origin* root — which under a sub-path deployment belongs to a different
 * application (spike S3 caught the 404). An absolute URL is left alone.
 *
 * **Both spellings are accepted**, and they mean the same file. The schema
 * describes the value as a path *under* `branding/` (`logo.svg`), while the
 * shipped `config.example/config.jsonc` has always shown `branding/logo.svg` —
 * a path relative to the config folder. Whichever an operator copied, the file
 * they mean is `${configDir}/branding/logo.svg`, so the redundant prefix is
 * dropped rather than doubled. The alternative was to serve
 * `/branding/branding/logo.svg` to half of them and 404 the other half.
 */
function brandingUrl(paths: BasePaths, value?: string): string | undefined {
  if (!value) return undefined
  if (/^https?:\/\//i.test(value)) return value
  const withinBranding = value.replace(/^\/+/, "").replace(/^branding\//, "")
  if (withinBranding === "") return undefined
  return paths.path(`/branding/${withinBranding}`)
}

export function buildUiContext(config: IdpConfig, locale: string): UiContext {
  const paths = createBasePaths(config.base)
  const file = config.file

  return {
    siteName: file.site.name,
    adminTitle: file.site.adminTitle ?? file.site.name,
    logo: brandingUrl(paths, file.site.logo),
    favicon:
      brandingUrl(paths, file.site.favicon) ?? paths.path("/favicon.ico"),
    theme: file.site.theme,
    supportEmail: file.site.supportEmail,
    termsUrl: file.site.termsUrl,
    privacyUrl: file.site.privacyUrl,
    locale,
    basePath: paths.basePath,

    signUpEnabled: file.signUp.enabled,
    requireApproval: file.signUp.requireApproval,
    emailEnabled: config.emailEnabled,
    requireEmailVerification: config.requireEmailVerification,
    twoFactorEnabled: file.twoFactor.enabled,
    twoFactorTrustDeviceDays: file.twoFactor.trustDeviceDays,
    apiKeysEnabled: file.apiKeys.enabled,
    allowImpersonation: file.admin.allowImpersonation,
    adminDatabaseEnabled: file.admin.database !== "disabled",
    apiKeyMaxExpiresInDays: Math.max(
      1,
      Math.floor(file.apiKeys.maxExpiresIn / 86_400)
    ),
    passwordMinLength: file.auth.password.minLength,
    oauthScopes: [...file.oauth.scopes],

    socialProviders: Object.entries(file.social)
      .filter(([, provider]) => provider.enabled)
      .map(([id]) => ({ id, label: labelFor(id) })),
  }
}
