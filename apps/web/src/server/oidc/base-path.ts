/**
 * The single source of truth for every path and absolute URL (OPS-10, SEC-1, risk R3).
 *
 * `server.baseUrl` may carry a path (`https://apps.example.com/idp`). Six
 * different knobs then have to agree — Vite's `base`, the TanStack router's
 * `basepath`, Better Auth's `baseURL` and `basePath`, the cookie `Path`, and
 * every absolute URL in discovery documents and e-mails. Deriving them all from
 * one place is what stops the sub-path deployment from being a permanent source
 * of "works at the root, 404s behind Caddy" bugs.
 *
 * Two of those knobs are not read from here, because they belong to bundles
 * this module cannot reach (spike S3, `docs/spikes/s3-sub-path.md`):
 *
 *  - **Vite's `base`** is `"./"`, fixed at build time. It makes the client
 *    bundle relocatable; the two URLs it cannot fix — the SSR asset manifest
 *    and `?url` imports — are pinned to the mount path at runtime, in
 *    `src/server-entry.ts` and `src/lib/base-path.ts`.
 *  - **The router's `basepath`** is a runtime value that reaches the browser
 *    on `<html data-base-path>` and is re-applied on every `router.update`
 *    (`src/router.tsx`), because Start pushes its build-time value in there.
 *
 * {@link BasePaths.authBasePath} is what Better Auth is configured with, and
 * {@link BasePaths.authBaseUrl} is where its endpoints answer. They are not
 * interchangeable: 1.7.1 appends `basePath` to `baseURL` only when `baseURL`
 * has no path of its own, so the issuer must **not** be passed as `baseURL` —
 * see the comment on `createAuthOptions`.
 *
 * Nothing here ever reads `Host` or `X-Forwarded-Host` (SEC-1).
 */

import type { BasePathInfo } from "../config/derive"

/** Where Better Auth mounts its own endpoints, relative to `baseUrl`. */
export const AUTH_BASE_PATH = "/api/auth"

export interface BasePaths {
  /** `https://apps.example.com` */
  origin: string
  /** `/idp`, or `""` at the host root. */
  basePath: string
  /** `https://apps.example.com/idp` — the issuer, byte-for-byte. */
  issuer: string
  /** Cookie `Path`: `/idp`, or `/` at the host root. */
  cookiePath: string
  /** `Secure` cookies whenever the issuer is https, whatever the internal scheme is. */
  secureCookies: boolean

  /** Turns an app-relative path into one the browser can use: `/login` → `/idp/login`. */
  path: (relative: string) => string
  /** Turns an app-relative path into an absolute URL: `/login` → `https://apps.example.com/idp/login`. */
  url: (relative: string) => string

  /** `https://apps.example.com/idp/api/auth` — Better Auth's own mount point. */
  authBaseUrl: string
  /** `/idp/api/auth` */
  authBasePath: string
}

export function createBasePaths(base: BasePathInfo): BasePaths {
  const issuer = `${base.origin}${base.basePath}`

  const path = (relative: string): string => {
    if (relative === "" || relative === "/")
      return base.basePath === "" ? "/" : base.basePath
    const normalized = relative.startsWith("/") ? relative : `/${relative}`
    return `${base.basePath}${normalized}`
  }

  return {
    origin: base.origin,
    basePath: base.basePath,
    issuer,
    cookiePath: base.cookiePath,
    secureCookies: base.secure,
    path,
    url: (relative) => `${base.origin}${path(relative)}`,
    authBaseUrl: `${issuer}${AUTH_BASE_PATH}`,
    authBasePath: `${base.basePath}${AUTH_BASE_PATH}`,
  }
}

/**
 * The public routes the OAuth provider and the gate chain redirect to.
 * Kept together so a rename cannot half-happen.
 */
export const APP_ROUTES = {
  login: "/login",
  signup: "/signup",
  /** First-run setup, reachable only while the `user` table is empty (D52). */
  setup: "/setup",
  forgotPassword: "/forgot-password",
  resetPassword: "/reset-password",
  verifyEmail: "/verify-email",
  twoFactor: "/two-factor",
  consent: "/consent",
  pendingApproval: "/pending-approval",
  banned: "/banned",
  changePassword: "/change-password",
  logout: "/logout",
  endSession: "/oauth2/end-session",
  /** The confirmation page for a logout with no `id_token_hint` (FR-OIDC-11). */
  endSessionConfirm: "/sign-out",
  account: "/account",
  admin: "/admin",
  error: "/error",
} as const

/**
 * Protocol endpoints that must sit at the issuer root rather than under Better
 * Auth's `basePath` (FR-OIDC-4/15). Thin server routes delegate them to
 * `auth.handler`.
 */
export const PROTOCOL_ROUTES = {
  authorize: "/oauth2/authorize",
  token: "/oauth2/token",
  userinfo: "/oauth2/userinfo",
  introspect: "/oauth2/introspect",
  revoke: "/oauth2/revoke",
  endSession: "/oauth2/end-session",
  jwks: `${AUTH_BASE_PATH}/jwks`,
  openidConfiguration: "/.well-known/openid-configuration",
  oauthAuthorizationServer: "/.well-known/oauth-authorization-server",
  jwksWellKnown: "/.well-known/jwks.json",
  changePassword: "/.well-known/change-password",
  /**
   * Served only when the config folder has one; the route 404s otherwise. Here
   * rather than as a literal in `discoveryUrls`, because this object exists so
   * that a rename cannot half-happen.
   */
  securityTxt: "/.well-known/security.txt",
} as const

/** One labelled absolute URL on the admin system page (FR-ADMIN-2, **D55**). */
export interface DiscoveryUrl {
  /** A stable key the catalog translates; never shown raw. */
  key: string
  url: string
}

/**
 * Every well-known URL this deployment answers on, absolute (**D55**).
 *
 * The operator's actual question — "what do I paste into the other system?" —
 * had no answer on any page: the issuer was shown, and every discovery URL had
 * to be assembled by hand from it. Under a sub-path that is exactly where it
 * goes wrong, because **two** URLs are correct and they are not the same one:
 * RFC 8414 §3.1 says an authorization server whose issuer has a path component
 * publishes its metadata at `{origin}/.well-known/oauth-authorization-server{path}`
 * — the well-known segment *before* the path. OpenID Discovery defines no such
 * form, but enough clients ask for it anyway that `Caddyfile.subpath` rewrites
 * **both** origin-root spellings, so both are listed: an operator whose proxy
 * is not the shipped one has to see the URLs to know which rules they are
 * missing, and listing only the RFC 8414 one would have them add half of what
 * the reference deployment does.
 *
 * The two origin-root entries are labelled as the reverse proxy's, because
 * they sit *above* this app's mount point and therefore cannot be routes here.
 *
 * `securityTxt` is included only when the file exists, because the route 404s
 * when it does not and a listed link that 404s is worse than no link.
 */
export function discoveryUrls(
  base: BasePaths,
  options: { securityTxt: boolean } = { securityTxt: false }
): DiscoveryUrl[] {
  const urls: DiscoveryUrl[] = [
    {
      key: "openidConfiguration",
      url: `${base.issuer}${PROTOCOL_ROUTES.openidConfiguration}`,
    },
    {
      key: "oauthAuthorizationServer",
      url: `${base.issuer}${PROTOCOL_ROUTES.oauthAuthorizationServer}`,
    },
  ]

  if (base.basePath !== "") {
    urls.push(
      {
        key: "oauthAuthorizationServerRoot",
        url: `${base.origin}${PROTOCOL_ROUTES.oauthAuthorizationServer}${base.basePath}`,
      },
      {
        key: "openidConfigurationRoot",
        url: `${base.origin}${PROTOCOL_ROUTES.openidConfiguration}${base.basePath}`,
      }
    )
  }

  urls.push(
    { key: "jwks", url: `${base.issuer}${PROTOCOL_ROUTES.jwksWellKnown}` },
    {
      key: "changePassword",
      url: `${base.issuer}${PROTOCOL_ROUTES.changePassword}`,
    }
  )

  if (options.securityTxt) {
    urls.push({
      key: "securityTxt",
      url: `${base.issuer}${PROTOCOL_ROUTES.securityTxt}`,
    })
  }

  return urls
}
