# semantius-idp — Specification v1

**Status:** signed off (2026-08-23) · **Date:** 2026-08-23 · **Supersedes:** `spec-v0.md` (kept as history)
**Scope of this document:** complete, numbered requirements for v1. No implementation plan, no code. The implementation plan is derived from this document after sign-off.

Sources: `spec-v0.md`, owner decisions D1–D26 and Q1–Q16 (§12), verified facts V1–V8 (§12.3), independent plan audit (applied; audit-set defaults are marked *(audit default)*). Implementation risks that must be verified in an early spike are listed in §13 — requirements depending on them reference the risk id.

---

## 1. Purpose, goals, non-goals

### 1.1 Purpose

A **lightweight, self-hosted identity provider (IdP)** delivered as a single Docker container. It provides user management and authentication for internal applications and issues **standard JWT access tokens** that are validated via **JWKS** by resource servers — explicitly including **Neon** (RLS / Data API) and Supabase-style PostgREST consumers.

### 1.2 Goals

- G1 — Single-tenant OIDC/OAuth 2.1 provider: login, sign-up with approval, password reset, social sign-in, 2FA, per-user API keys. (Machine-to-machine / `client_credentials` is **out of scope for v1**, D26.)
- G2 — **Configured by files + environment**: `config.json`, `oauth_clients.json`, `roles.json` in a config folder are the source of truth; secrets arrive via environment variables or secret files. A container is fully configured without touching the database.
- G3 — **JWTs that Neon accepts out of the box**: ES256, `kid` in the header, JWKS + discovery served at the issuer, audience configurable.
- G4 — Lean and self-contained: one container + Postgres; the only optional external services are Resend (e-mail) and the enabled social providers.
- G5 — Operable: health endpoints, structured logs, audit trail, automated migrations, documented runbooks, automated tests.
- G6 — Runs standalone (local/dev) or behind a Caddy reverse proxy, **including under a URL sub-path** (e.g. `https://apps.example.com/idp`).

### 1.3 Non-goals (v1)

Multi-tenancy/organizations · billing · **machine-to-machine tokens** (`client_credentials` grant and `service` clients — D26, v1.1) · **account linking** (deliberately absent, see FR-SOC-2) · SAML · SCIM/LDAP/external user stores · passkeys · magic links / e-mail OTP login · user-supplied template/theme overrides (built-in light/dark stays) · pairwise subject identifiers · generic upstream OIDC providers (`genericOAuth` — v1.1) · SMTP transport (v1.1; v1 is Resend-only) · configuration hot reload · multi-replica operation (replica-*safe*, not replica-*supported*) · metrics/OpenTelemetry · locales beyond en-US (structure prepared) · load/performance testing beyond the footprint targets in OPS-13.

---

## 2. Glossary & actors

| Term | Meaning here |
|---|---|
| **IdP** | This product: the auth server + its UI in one container. |
| **End user** | A person with a `user` row; signs in at the IdP. |
| **Admin** | An end user holding a role listed in `admin.adminRoles`. Only admins reach `/admin/*` and the admin API. |
| **Client / RP** | An application registered in `oauth_clients.json` that sends users through the OIDC authorization-code flow. |
| **First-party app** | A client flagged `firstParty: true` running on the **same host** as the IdP (it shares the host-only session cookie; the sub-path deployment exists precisely for this). |
| **Resource server / verifier** | Anything that validates the IdP's JWTs via the JWKS: Neon (proxy + `pg_session_jwt`), Supabase-style PostgREST, internal APIs using `jose`. Neon is a **verifier, not a client**. |
| **Issuer** | The exact value of `server.baseUrl` — scheme + host[:port] + optional path, no trailing slash. |
| **Audience / resource** | RFC 8707 resource identifier; becomes the JWT `aud` claim. |
| **Operator** | Whoever deploys/configures the container. |
| **Catalog role** | A role defined in `roles.json`; stored per user in the Better-Auth column `user.role` (comma-separated), emitted as the `roles` array claim. |

---

## 3. Architecture

One deployable unit: a **TanStack Start** application (default SSR; server routes host all protocol endpoints) executed by **Bun**, embedding **Better Auth** with the plugins `admin`, `jwt`, `oauth-provider`, `api-key`, `two-factor` (plus a small local plugin contributing the `audit_log` schema and custom endpoints). State lives in **Postgres** (schema `idp` by default). Configuration is read once at startup from the config folder + environment. A **Caddy** reverse proxy (reference config shipped) terminates TLS in production; standalone HTTP is for local/dev only.

```
Browser ──► Caddy ──► IdP container (TanStack Start + Better Auth, Bun)
                         │  /login /account /admin …          (SSR pages)
                         │  /api/auth/* /oauth2/* /.well-known/* /healthz  (server routes)
                         ▼
                      Postgres (schema: idp)

Neon / APIs ──(fetch JWKS over public https)──► {baseUrl}/api/auth/jwks
Client apps ──(OIDC code+PKCE / session JWT / x-api-key)──────────────────────► IdP
```

Frontend stack note: TanStack Start with its **default SSR** (server-side route loaders gate `/admin/*` at first paint; the login page renders without a JS flash). **TanStack Query is not a v1 dependency** — Better Auth's React client plus router loaders/server functions with `router.invalidate()` cover all data needs; Query may be added later without spec impact. UI components: shadcn on `@base-ui/react` from the workspace `packages/ui`.

---

## 4. Technology & versions

| Component | Requirement |
|---|---|
| Better Auth | **Latest stable at implementation start** (1.7.1 at spec time) — exact version pinned and recorded in the decision log; plugins: core, `admin`, `jwt`, `oauth-provider`, `api-key`, `two-factor`. The v0 sample schema is a **naming reference only**; the authoritative schema is generated from the installed Better Auth's own `getAuthTables()` for the enabled plugins (§7, DM-1, D29). |
| Runtime | **Bun**, pinned (`.bun-version` + `engines.bun`). Node is used only by CI tooling; the scaffold's `engines.node >= 20` is amended accordingly. |
| Framework | TanStack Start (default SSR) + TanStack Router; Vite; React 19. |
| UI | shadcn + `@base-ui/react`, Tailwind 4, from `packages/ui`. |
| ORM / DB | Drizzle + postgres driver; Postgres ≥ 16 (compose ships 16/17). |
| Package manager | pnpm, committed lockfile, `--frozen-lockfile` in CI/image. |
| Pinning policy | v0's "latest" = latest stable **at implementation start**, then **pinned exactly** — all dependencies, including every `@tanstack/*` currently at `latest` in the scaffold. Upgrades are explicit changelog entries. |

---

## 5. Functional requirements

Format: each requirement has an id, a normative statement, and acceptance criteria (**AC**). "Config:" names the keys from §6 that govern it.

### 5.1 Authentication — password (FR-AUTH)

**FR-AUTH-1 — Password sign-in.** Users sign in with e-mail + password at `/login`. Passwords: min 12 / max 128 characters, no composition rules; optional breached-password check behind `auth.password.breachCheck` (default false). E-mails are trimmed and lower-cased everywhere (sign-up, sign-in, social, admin). A completed sign-in resolves its destination in this order (D28): a pending OAuth authorization continuation (FR-OIDC-9) · a `returnTo` query parameter that validates as a same-origin relative path (SEC-3, unchanged) · `auth.defaultRedirect` · `/account`. The same resolver governs **password-change completion**, because FR-AUTH-4 interposes `/change-password` before that destination and an absolute `auth.defaultRedirect` cannot round-trip through a `returnTo` parameter that only accepts relative paths — so the forced-change handler re-resolves at the end rather than carrying the value through the query. Sign-up, password reset and verification keep their own endings.
*AC:* valid credentials create a session; 11-character password rejected at sign-up/change; sign-in failure message is identical for wrong password and unknown e-mail.
*AC (D28):* with `auth.defaultRedirect` unset, sign-in lands on `/account`; with it set to an absolute URL, both a plain sign-in and a forced password change land there; a `returnTo` of `https://evil.example` is still ignored; a bare hostname is rejected at configuration load.

**FR-AUTH-2 — E-mail verification.** `auth.requireEmailVerification` (default **true**; forced false when e-mail is not configured, FR-MAIL-2) gates **password sign-in only**: unverified password accounts cannot sign in and are offered a resend. Social accounts are never gated by it — their `emailVerified` comes from the provider claim (FR-SOC-4); unverified users carry a badge in the admin UI.
*AC:* with verification on, a fresh password sign-up cannot sign in before clicking the e-mailed link; the link is single-use and expires (24 h); resend is rate-limited.

**FR-AUTH-3 — Password reset.** `/forgot-password` sends a reset link when e-mail is configured (FR-MAIL-1); response is identical whether or not the account exists. Reset tokens are single-use, expire after 1 h, and are invalidated by any password change. Completing a reset (or any password change) revokes all other sessions **and all OAuth tokens** of the user (FR-OIDC-12). A notification e-mail is sent on password change.
*AC:* token reuse fails; after reset, an existing refresh token is rejected; the response for an unknown e-mail is byte-identical (modulo timing) to a known one.

**FR-AUTH-4 — Forced password change.** Users flagged `mustChangePassword` (bootstrap admin, admin-set temporary passwords) are interposed with a change-password step before anything else completes (including OAuth continuations, FR-OIDC-9).
*AC:* a `mustChangePassword` user completing `/oauth2/authorize` is routed through the change form before the client redirect.

**FR-AUTH-5 — Sessions & cookies.** Sessions last 7 d sliding (`session.expiresIn`), refreshed when older than 1 d (`session.updateAge`); cookie cache ≤ 5 min so revocations bite quickly. Cookies: `HttpOnly`, `Secure` whenever `server.baseUrl` is https (independent of the internal scheme), `SameSite=Lax`, **host-only** (no `Domain`), `__Secure-` prefix when secure, `Path` scoped to the `baseUrl` path. Sensitive actions (change password/e-mail, 2FA enrol/disable, API-key creation, consent revoke-all, every admin write) require a session fresher than 15 min (`session.freshAge`) or re-authentication.
*AC:* cookie attributes asserted in tests; a 20-minute-old session is prompted to re-authenticate before creating an API key.

**FR-AUTH-6 — Logout.** `POST {baseUrl}/api/auth/sign-out` deletes the session and clears the cookie; the `/logout` page calls it and redirects to `/login` or a **same-origin** `returnTo`. `session.revokeOAuthTokensOnLogout` (default false) additionally revokes the session's OAuth refresh tokens. OIDC RP-initiated logout is FR-OIDC-11.
*AC:* after sign-out the cookie is expired and `/account` redirects to `/login`.

**FR-AUTH-7 — Mass-assignment protection.** `role`, `banned`, `banReason`, `banExpires`, `emailVerified`, `status`, `approvedAt`, `approvedBy`, `mustChangePassword` are declared `input: false` — settable only through admin/internal paths.
*AC:* a sign-up body containing `{"role": "admin", "status": "active"}` creates a default-role pending user; the fields are ignored or rejected.

### 5.2 Sign-up & approval (FR-SIGNUP)

**FR-SIGNUP-1 — Global sign-up switch.** `signUp.enabled` (default **false**) governs password *and* social registration. When off: `/signup` returns 404 and is unlinked, `emailAndPassword.disableSignUp` is set, and every enabled social provider gets `disableImplicitSignUp` — social sign-in then succeeds **only** for already-registered `(providerId, accountId)` identities (FR-SOC-3).
*AC:* with sign-up off, a password registration attempt gets a 4xx; a Google sign-in by an unknown Google account is refused with a neutral message.

**FR-SIGNUP-2 — Approval workflow.** `signUp.requireApproval` (default **true**) applies to all self-registration paths. Users carry `status ∈ {pending, active, rejected}` plus `approvedAt`, `approvedBy`. Order: sign-up → e-mail verification (when required) → approval. A non-`active` user obtains **no session, no authorization code, no access/refresh token and no API-key authentication on any path** — password, social, `/oauth2/authorize`, `refresh_token` grant, `x-api-key`, session-JWT endpoint (enforced in the session-creation hook and re-checked in the refresh and API-key paths). Pending users see `/pending-approval`. Admin-created and bootstrap users are `active` immediately. Rejected users keep their row (e-mail stays reserved; sign-in shows a neutral refusal); deleting the user afterwards allows a fresh sign-up. Approval/rejection triggers an e-mail to the user, and new pending sign-ups trigger an e-mail to all admins — only when e-mail is configured (FR-MAIL-1).
*AC:* pending user: password login refused, social login refused, refresh grant refused, API key refused; after admin approval the same credentials work; the sign-up→approve→login path is an integration test.

**FR-SIGNUP-3 — Domain restriction.** `signUp.allowedEmailDomains[]` (empty = no restriction) rejects self-registrations whose e-mail domain is not listed; applies to password and social sign-up. Admin-created users bypass it.
*AC:* with `["example.com"]`, `user@gmail.com` cannot self-register.

**FR-SIGNUP-4 — Configuration sanity warnings.** Startup warns (does not fail) on `signUp.enabled && !signUp.requireApproval && e-mail off` ("unverified open registration"). A social provider enabled while `signUp.enabled = false` is a supported configuration and produces **no** warning (D26 → D25: the combination is the normal "invite-only, social sign-in for existing identities" deployment).
*AC:* the "unverified open registration" warning is asserted in config-loader tests; a config with a social provider enabled and `signUp.enabled = false` produces no warning.

**FR-SIGNUP-5 — Name capture.** Sign-up and admin create/edit forms collect optional `firstName`/`lastName`; `name` defaults to `"firstName lastName"` when not provided separately. Social providers map `given_name`/`family_name` into `firstName`/`lastName`.

### 5.3 Social sign-in (FR-SOC)

**FR-SOC-1 — Config-driven providers.** Social providers are enabled solely via `config.json → social.<providerId>` for any Better Auth built-in provider id (`google`, `github`, `microsoft` (Entra), …): `{ enabled, clientId, clientSecret (placeholder), …provider options }`. Callback URL per provider is `{baseUrl}/api/auth/callback/<providerId>` and is documented per provider.
*AC:* a provider absent from config does not render a button and its callback route is inert.

**FR-SOC-2 — No account linking, identity by provider subject.** Account linking is **disabled entirely** (no option). A social identity maps to exactly one user via `(providerId, accountId)` where `accountId` is the provider's **stable subject** — for Entra the `oid` claim (verified in Better Auth 1.7.1), never e-mail/UPN. E-mail is profile data only. Consequences (all stated in the README): an existing password user can never attach a social identity; a social sign-in whose e-mail equals another user's e-mail is **rejected** with "sign in with your original method" (e-mail stays unique); a provider-side e-mail change can never map to a different user.
*AC:* password user `a@x.com` + Google account with e-mail `a@x.com` → refusal, no link, no new user; Entra user whose mail changes → same user record.

**FR-SOC-3 — Sign-up interaction.** With sign-up enabled, an unknown `(providerId, accountId)` creates a user (subject to FR-SIGNUP-2/3); with sign-up disabled it is refused (FR-SIGNUP-1).

**FR-SOC-4 — Profile sync.** `social.<p>.syncProfile` (default true) updates `email`, `name`, `image` (and `firstName`/`lastName` when mapped) from the provider on **every** sign-in of an existing account; `emailVerified` follows the provider's claim. If the incoming e-mail collides with **another** user's e-mail, the **sign-in is blocked** (D24): no session is created, the user sees the same neutral "sign in with your original method" refusal as FR-SOC-2, the profile is left untouched, and audit event `social.profile_conflict` is written and flagged in the admin user detail. Rationale: proceeding would leave the account's e-mail permanently diverged from the provider's, and a silent skip hides an identity collision that an admin must resolve. (Risk R7.)
*AC:* user A has e-mail `a@x.com`; user B signs in with a Google identity whose provider e-mail has changed to `a@x.com` → sign-in refused with the neutral message, B's row unchanged, one `social.profile_conflict` audit row.

**FR-SOC-5 — Entra tenant lock.** `social.microsoft.tenantId` is **required** — a tenant GUID or verified tenant domain; `common`, `organizations`, `consumers` are rejected by validation. `social.<p>.allowedEmailDomains` may restrict further.
*AC:* config with `tenantId: "common"` fails validation.

### 5.4 Two-factor authentication (FR-2FA)

**FR-2FA-1 — TOTP, optional per user.** Better Auth `twoFactor` plugin: TOTP + backup codes. Enrolment from the account page (QR + verification; backup codes shown once); disabling requires password re-entry; login gains a 2FA step with "trust this device" for `twoFactor.trustDeviceDays` (default 30). 2FA is enforced at IdP login, so **all OIDC flows inherit it**; API keys bypass it by design (documented). TOTP issuer label = `twoFactor.issuer` (default `site.name`).
*AC:* enrolled user: password alone insufficient; backup code works once; OAuth authorize routes through the 2FA step.

**FR-2FA-2 — Admin reset.** Admins can reset a user's 2FA (custom action: delete the `two_factor` rows, clear `twoFactorEnabled`, revoke sessions, audit-log).

### 5.5 Account self-service (FR-ACCT)

**FR-ACCT-1 — Account page.** `/account` provides: profile (name, firstName, lastName, image), change password (current password required; revokes other sessions + OAuth tokens), change e-mail (with verification of the new address; hidden when e-mail is off — admins edit directly), 2FA management, API keys (FR-KEY), active sessions with revoke, granted consents with revoke. **No self-deletion** (admin only).

**FR-ACCT-2 — Public UI inventory.** `/login` (password + enabled social buttons + OAuth continuation), `/signup` (404 when disabled), `/forgot-password`, `/reset-password` (valid/expired/used states), `/verify-email` (result + resend), 2FA challenge, `/consent`, `/pending-approval`, `/banned` (reason/expiry when set), forced-change-password, `/logout`, end-session confirmation, `/account/*`, error pages (404, 403, 500, OAuth error, 429 with retry-after). All strings from the en-US catalog (FR-I18N-1); WCAG 2.1 AA, labelled inputs with `autocomplete` (`username`, `current-password`, `new-password`), password visibility toggle, inline policy hint, mobile-first; no "remember me" (session length is config).

### 5.6 Per-user API keys (FR-KEY)

**FR-KEY-1 — Keys.** Better Auth `apiKey` plugin, gated by `apiKeys.enabled` (default true). Users create keys in `/account` (name + expiry ≤ `apiKeys.maxExpiresIn`, default expiry `apiKeys.defaultExpiresIn` = 365 d, max 730 d); admins can create/list/revoke keys for any user. Keys are hashed at rest, shown once, prefixed for recognisability, revocable, rate-limited per key.
*AC:* a listed key never shows its secret again; a revoked or expired key stops authenticating.

**FR-KEY-2 — Authentication semantics.** A request with `x-api-key` authenticates **as the owning user** (same roles/claims). Keys are rejected when the user is not `active` or is banned (FR-SIGNUP-2, FR-ADMIN-4); they bypass 2FA (documented); they confer admin-API access only when the owner holds an admin role. Creation/revocation/use-failures are audit-logged.

**FR-KEY-3 — JWT exchange.** `GET {baseUrl}/api/auth/token` with `x-api-key` returns a JWT built by the **same claims builder** as OAuth access tokens (FR-OIDC-7): `azp = apiKeys.tokenClientId` (default `"idp"`), random `sid`, `scope = "openid profile email"`, `exp = iat + apiKeys.tokenTtl` (default 3600 s), `aud = jwt.audience`.
*AC:* the exchanged JWT validates against the JWKS and passes the Neon constraints test (TST-4).

### 5.7 Roles (FR-ROLE)

**FR-ROLE-1 — Catalog in `roles.json`.** Entries `{ name, description, default? }`. Absent file ⇒ built-in catalog `[{ name: "admin" }, { name: "user", default: true }]`. Validation: names unique, `^[a-z0-9_-]{1,64}$` (no commas); **exactly one** `default: true` — it feeds the admin plugin's `defaultRole` and is assigned at self-registration; every entry of `admin.adminRoles` (default `["admin"]`) must exist in the catalog. Roles are **labels for downstream apps**: the IdP evaluates no permissions from them.

**FR-ROLE-2 — Assignment & claims.** A user may hold several catalog roles, stored comma-separated in the Better-Auth-fixed column `user.role` and emitted as the **`roles: string[]`** claim (FR-OIDC-7). **Naming rule:** the singular `role` claim is *never* derived from `user.role`; it exists only as a static value from `jwt.claims` (FR-OIDC-8). Role values no longer in the catalog are dropped from claims, warned at boot, and flagged in the admin UI. Admins assign roles from the catalog; changing definitions = edit `roles.json` + restart.
*AC:* user with `user.role = "admin,billing"` gets `roles: ["admin","billing"]`; an unknown stored role is excluded from the claim and visible as a warning in `/admin/users/:id`.

**FR-ROLE-3 — Admin gating.** Only users holding a role in `admin.adminRoles` can access `/admin/*` (server-side in route loaders **and** at the API), everything else returns 403.

### 5.8 Admin (FR-ADMIN)

**FR-ADMIN-1 — Bootstrap admin.** `admin.bootstrap: { email, password, name? }` in `config.json` (values via `${env:…}` placeholders, e.g. `${env:IDP_ADMIN_EMAIL:-}`). At startup, **iff no user holds an admin role**, the bootstrap user is created — `active`, e-mail verified, admin role, `mustChangePassword` — under an advisory lock; otherwise no-op. Empty/absent values skip bootstrap with a loud warning (`idp create-admin` is the alternative), so the env vars can be unset after first boot. The password is never logged. Automatic promotion of the first sign-up is forbidden.
*AC:* two consecutive boots create exactly one admin; removing the env vars later does not demote anyone.

**FR-ADMIN-2 — Admin UI.** `/admin` dashboard (pending count, user/session totals) · `/admin/users` (search by e-mail/name; filters: role, status, banned, verified; sort; page sizes 25/50/100) · user detail (profile, roles, status, linked identities, sessions, API keys, audit excerpt) · create user (pre-approved + verified; set-password link e-mailed when e-mail is on, otherwise shown **one-time** in the UI; or admin sets a temporary password + `mustChangePassword`) · edit (name, e-mail, verified flag, roles) · approve/reject · ban/unban (reason, optional expiry) · set password / send reset · revoke sessions · delete (confirmation; cascades tokens/keys) · 2FA reset (FR-2FA-2) · `/admin/clients` and `/admin/roles` **read-only** with "managed by oauth_clients.json / roles.json" notice, last-reconcile timestamp and warnings · `/admin/audit` (filterable) · `/admin/system` (version, masked effective config, e-mail transport status, signing key alg/kid + rotate action, migration state, last reconcile result).

**FR-ADMIN-3 — Invariants.** Admins cannot change their own roles, ban or delete themselves; the **last admin** cannot be demoted, banned, deleted or set non-active; only admins can grant admin roles; all enforced server-side.

**FR-ADMIN-4 — Ban.** Better Auth OOTB ban: `banned`, `banReason`, `banExpires`; banning revokes sessions **and** OAuth tokens and blocks API keys (FR-OIDC-12); banned users see the reason/expiry at login. Ban fields never appear in JWTs.

**FR-ADMIN-5 — Impersonation (optional).** Behind `admin.allowImpersonation` (default **off**). When on: ≤ 1 h, never against users holding an admin role, session carries `impersonatedBy`, UI shows a persistent banner, everything audit-logged. During impersonation: no password/e-mail/2FA/API-key changes, no `/oauth2/authorize`, no session-JWT issuance, no admin API.

**FR-ADMIN-6 — Admin HTTP API.** The Better Auth admin endpoints plus the custom approval endpoints form the documented, role-gated management API (this is v0's "pluggable user management"). Callable with an admin session or the `x-api-key` of an admin user.

### 5.9 OAuth 2.1 / OIDC provider (FR-OIDC)

**FR-OIDC-1 — Grants & response types.** Supported: `authorization_code` with **PKCE S256 only** (`plain` rejected; PKCE mandatory for public clients, default-on for confidential) and `refresh_token` — **these two only** (D26). `response_types_supported = ["code"]`. `client_credentials`, implicit, hybrid, ROPC and device-code are disabled, rejected with `unsupported_grant_type`, and absent from `grant_types_supported` in discovery. Authorization codes: single-use, TTL 60 s, bound to client + redirect URI + code challenge; replay of a consumed code revokes the tokens issued from it.

**FR-OIDC-2 — Clients from `oauth_clients.json`.** The file is the **source of truth**; at startup it is validated and reconciled into `oauth_client` (+ resource links) — the operative store Better Auth reads at runtime: insert missing, update changed (secret re-hash on change, `createdAt` preserved), clients absent from the file ⇒ `disabled = true` + revoke their tokens/consents (`oauth.reconcile.prune: true` deletes rows instead, default false). All ids are registered in `cachedTrustedClients`; dynamic client registration (`/oauth2/register`) stays off; client CRUD endpoints are denied for every caller (404/403); the admin UI is read-only. Reconciliation is transactional under an advisory lock; its diff is audit-logged; validation failure aborts startup. Config-synced rows use `user_id = NULL`.
*AC:* editing a redirect URI in the file + restart changes behaviour; an admin calling the create-client endpoint gets 403/404; removing a client (prune off) leaves a disabled row and its refresh token stops working.

**FR-OIDC-3 — Client schema.** Per entry: `clientId` (required, unique), `name`, `type: "web" | "spa" | "native"` (D26 removed `service`; mapping: `spa`/`native` ⇒ public — no secret, `tokenEndpointAuthMethod: "none"`, PKCE required; `web` ⇒ confidential — `clientSecret` placeholder ≥ 32 chars, `client_secret_basic` (default) or `client_secret_post`), `firstParty` (FR-OIDC-14), `redirectUris` (absolute, exact-match, no wildcards/fragments, https except loopback `http://127.0.0.1` / `http://localhost`; private-use schemes allowed for `native`), `postLogoutRedirectUris`, `scopes` (⊆ `oauth.scopes`), `audience` (string/array — per-client default audience, FR-OIDC-6), `grantTypes` (⊆ `["authorization_code", "refresh_token"]`), `responseTypes` (`["code"]`), `requirePKCE` (default true), `skipConsent` (default **true**), `enableEndSession` (default true; requires `postLogoutRedirectUris`), `disabled`, `uri`, `icon`, `contacts`, `tos`, `policy`, `metadata`. Unknown fields rejected. Exact field mapping is frozen after risk R9 is verified.
*AC:* validation errors for duplicate `clientId`, public client with secret, confidential client without secret, `type: "service"` or a `client_credentials` entry in `grantTypes` (rejected as unsupported in v1, D26), undeclared scope/audience.

**FR-OIDC-4 — Endpoints.** `/oauth2/authorize`, `/oauth2/token`, `/oauth2/userinfo`, `/oauth2/introspect` (client auth; answers only for the caller's own tokens unless the client is flagged `resourceServer: true`), `/oauth2/revoke` (RFC 7009; always 200), `/oauth2/end-session`. `/oauth2/register` and client/consent CRUD endpoints are unreachable (FR-OIDC-2). Unknown `client_id` or unregistered `redirect_uri` renders a branded error page and **never redirects**.

**FR-OIDC-5 — Always-JWT access tokens.** With an audience resolved (which v1 guarantees, FR-OIDC-6) every access token is a **signed JWT**; `jwt.algorithm ∈ {ES256 (default), RS256}` — any other value (incl. EdDSA/ES512/PS256) fails validation with a Neon-compatibility message. Header carries `alg` + `kid`.
*AC:* token from a plain code+PKCE login (no `resource` param) is a JWT that `jose` validates against the JWKS; the Neon constraints test (TST-4) passes.

**FR-OIDC-6 — Audience / resource model.** `jwt.audience` (string or array of absolute URIs) in `config.json` is **required** and is the default audience: applied as the RFC 8707 resource whenever a client sends no `resource` parameter (mechanism = risk R1). Per-client `audience` overrides the default; an explicit `resource` request is honoured when the client is linked to it. Effective resource registry = `oauth.resources[]` ∪ `jwt.audience` ∪ all per-client `audience`; reconcile seeds `oauth_resource` and links each client to the default plus its own audiences (risk R2); an unlinked/undeclared `resource` yields `invalid_target`.
*AC:* token without `resource` → `aud = jwt.audience`; token with allowed `resource` → that resource in `aud`; disallowed `resource` → `invalid_target`.

**FR-OIDC-7 — Access-token claims (one claims builder for all paths).** Payload: `iss` (= `baseUrl`), `sub` (= `user.id` — every v1 token is user-bound, D26), `aud` (FR-OIDC-6), `iat`, `exp`, `jti`, `scope`, `client_id`, `azp`, `sid` (session id; random for the API-key path), plus — when `jwt.includeUserData` (default true) — `email`, `name`, `given_name` (= firstName), `family_name` (= lastName), `roles` (string array, FR-ROLE-2), plus static claims from `jwt.claims` (FR-OIDC-8). `jwt.userClaims ⊆ {email, name, given_name, family_name, roles}` selects a subset; `includeUserData: false` removes exactly that set *(audit default)*. **Not** in access tokens: `email_verified`, `picture`, timestamps, ban/2FA fields. Which claims Better Auth auto-emits vs. the custom builder = risk R10.
*AC:* claim-set snapshot tests for: code+PKCE token, session-JWT and API-key JWT — all identical modulo `sub/sid/azp/scope`.

**FR-OIDC-8 — Static custom claims.** `jwt.claims: { name: value }`, default `{}` — e.g. `"role": "authenticated"` for Neon/Supabase (shipped in `config.example`, explained in the Neon guide; emitted **only when configured** *(audit default)*). Merged into access tokens; into ID tokens only when `jwt.claimsInIdToken` (default false). Reserved keys rejected by validation: `iss sub aud exp iat nbf jti scope auth_time azp sid client_id roles email name given_name family_name`.

**FR-OIDC-9 — Authorize flow & continuation.** The pending authorization request survives the interstitials in this order: login → status gate (pending/rejected/banned) → 2FA → forced password change → consent → redirect; held server-side ≤ 10 min within one browser session. Asynchronous approval does **not** resume the flow — the approval e-mail links to `/login` and the user restarts from the client. Supported request parameters: `prompt` (`none`, `login`, `consent`), `max_age`, `login_hint`, `nonce`, `state`, and `auth_time` is emitted. `prompt=none` yields `login_required`/`consent_required` without UI and only works for top-level/same-site callers (SameSite=Lax) — cross-site silent renew is unsupported; SPAs use refresh rotation. `request`, `request_uri` and `claims` parameters are unsupported and advertised as such.

**FR-OIDC-10 — Consent.** `skipConsent` defaults to true for all file clients (admin configured them); the consent page appears only for `skipConsent: false` clients or `prompt=consent`. Consent is stored per client + scope set and re-prompted on scope escalation; the consent POST is bound to the pending request and session; the page shows client name/icon/uri/tos/policy and per-scope descriptions. Users revoke consents in `/account` (revocation also revokes that client's tokens).

**FR-OIDC-11 — RP-initiated logout.** `/oauth2/end-session` per client (`enableEndSession`): `id_token_hint` validated; `post_logout_redirect_uri` must exactly match a registered value; `state` echoed; a confirmation page is shown when no valid hint is present. Logout ends the IdP session; token revocation on logout per FR-AUTH-6. Front-channel logout is out of scope; back-channel logout is optional (only if the pinned Better Auth version supports it — else documented out).

**FR-OIDC-12 — Revocation semantics.** Ban, rejection, deletion, password change/reset, and admin "revoke all" revoke **all sessions and all OAuth refresh/access-token records** of the user; the `refresh_token` grant and API-key verification re-verify user state on every use. **Caveat (documented in spec + Neon guide):** already-issued JWT access tokens remain valid for stateless verifiers until `exp` — bounded by the access-token TTL (default 15 min); revocation is immediate at refresh/introspect/userinfo and all IdP endpoints.

**FR-OIDC-13 — Token lifetimes.** Defaults (all configurable, §6): authorization code 60 s · access token 15 min (per-resource override via `oauth.resources[].accessTokenTtl`) · ID token 1 h · refresh token 30 d sliding with 90 d absolute maximum, **rotation on every use with reuse detection** revoking the token family; refresh tokens require the `offline_access` scope; the refresh grant re-validates requested scopes against the client's *current* allowed scopes.

**FR-OIDC-14 — First-party apps & session-JWT endpoint.** A **first-party app** (`firstParty: true`) runs on the **same host** as the IdP — cookies are host-only, so only same-host apps share the session (the sub-path deployment exists precisely for this: `https://apps.example.com/app1` beside `https://apps.example.com/idp`); apps on other subdomains are not first-party and use the OIDC flow. `GET {baseUrl}/api/auth/token` with the session cookie returns a JWT from the same claims builder (`azp: "idp"`, `sid` = session id, `scope "openid profile email"`, `aud = jwt.audience`, TTL `jwt.sessionToken.ttl` = 3600 s); the endpoint is **same-origin only** (excluded from CORS) and refuses pending/banned users. The same endpoint's `x-api-key` mode is FR-KEY-3. (Risk R5.)

**FR-OIDC-15 — Discovery & well-known.** Served at the issuer: `{baseUrl}/.well-known/openid-configuration` and `{baseUrl}/.well-known/oauth-authorization-server`; under a sub-path the RFC 8414 document **additionally** lives at the origin root `{origin}/.well-known/oauth-authorization-server{path}` (the shipped Caddyfile adds that route). `issuer` equals `server.baseUrl` byte-for-byte; every advertised endpoint resolves; advertised: `scopes_supported`, `claims_supported`, `grant_types_supported`, `response_types_supported`, `code_challenge_methods_supported = ["S256"]`, `token_endpoint_auth_methods_supported`, `id_token_signing_alg_values_supported` (= configured alg), `end_session_endpoint`, `revocation_endpoint`, `introspection_endpoint`, `ui_locales_supported: ["en-US"]`. Also served: `{baseUrl}/.well-known/jwks.json` (identical body to the canonical `jwks_uri = {baseUrl}/api/auth/jwks`), `/.well-known/change-password` → `/account`, optional `security.txt` from config, `robots.txt` (disallow all).
*AC:* discovery content asserted against configuration in tests, at root **and** under a sub-path.

**FR-OIDC-16 — JWKS & key management.** Keys generated at first boot (serialized via advisory lock), stored in `jwks` with the private key AES-256-GCM-encrypted by `secret`. JWKS responses: `Cache-Control: public, max-age=300` + ETag; entries carry `kid`, `alg`, `use: "sig"`. Rotation: `jwt.rotationInterval` (default 90 d) + `jwt.gracePeriod` (default = max token lifetime + 1 h ≥ Neon's JWKS cache); retired keys stay published until grace ends; a new key must be published before it signs (risk R11); manual rotation via `idp rotate-keys` and the admin UI. The JWKS and discovery URLs must be reachable over **public https** for Neon — deployments may expose only `/.well-known/*` and the JWKS path publicly while keeping the UI internal (documented).

**FR-OIDC-17 — CORS.** Discovery + JWKS: `Access-Control-Allow-Origin: *`. Token, revocation, userinfo: allow-list derived from the registered redirect-URI origins. Session endpoints and `GET /api/auth/token`: same-origin only.

### 5.10 E-mail (FR-MAIL)

**FR-MAIL-1 — Resend transport.** E-mail is sent via **Resend** (`email.resend.apiKey` placeholder, `email.from` required when enabled, `email.replyTo` optional). An internal transport abstraction has exactly two implementations in v1: `resend` and `capture` (tests/dev). No SMTP in v1.
Template inventory (HTML + text, branded from `site.*`, links built from `baseUrl` only): verify e-mail · reset password · set password (admin-created account) · new pending sign-up (to admins) · account approved · account rejected (optional) · password changed · 2FA enabled/disabled · API key created. Templates are not user-customizable in v1.

**FR-MAIL-2 — Degraded mode.** Without `email.resend.apiKey`: password reset, e-mail verification and **all** notification e-mails are disabled; affected UI is hidden; a startup warning is logged; `auth.requireEmailVerification` is forced false; admins manage passwords via temporary password / one-time link (FR-ADMIN-2); accounts show an "unverified" badge (Q8).
*AC:* with e-mail off, `/forgot-password` is absent and the sign-up→approval flow still works end-to-end.

### 5.11 i18n (FR-I18N)

**FR-I18N-1 — Prepared, en-US only.** Every UI and e-mail string lives in one message catalog (`en-US`). Locale resolution: first supported of `ui_locales` (authorize request) → locale cookie → `Accept-Language` → `site.defaultLocale` (default `en-US`). Only the en-US bundle ships in v1; adding a locale must not require code changes outside the catalog. Dates render in the browser locale.

---

## 6. Configuration model (CFG)

**CFG-1 — Folder.** `IDP_CONFIG_DIR` (default `/config`), read-only to the process: `config.json` (**required**), `oauth_clients.json` (optional ⇒ no clients; only the first-party session-JWT path is usable), `roles.json` (optional ⇒ built-in catalog, FR-ROLE-1), `branding/` (logo, favicon; served read-only). A mounted volume replaces any baked-in directory entirely. `config.example/` with fully commented examples + generated JSON Schemas (`config.schema.json`, `oauth_clients.schema.json`, `roles.schema.json`) ships in repo and image. Files are parsed as **JSONC** (comments, trailing commas); `$schema` is honoured and exempt from the unknown-key rule.

**CFG-2 — Placeholder grammar (D18).** Inside JSON **string values** only (never keys): `${env:NAME}`, `${env:NAME:-default}`, `${file:/abs/path}` (content read once, trailing newline trimmed — Docker/K8s secrets), `$${` escapes a literal `${`. `NAME` matches `[A-Z_][A-Z0-9_]*`. Single non-recursive pass, evaluated before schema validation; a value consisting of exactly one placeholder is coerced to the schema type by strict JSON parsing (`true`, `42`, `[...]`); embedded placeholders stay strings. Un-namespaced `${VAR}` and any malformed placeholder are errors (with a hint); an unresolved variable without default aborts startup naming file, JSON pointer and variable — never the value. Rationale (v0 asked for a common convention): compose/envsubst `${VAR}` collides with docker-compose's own interpolation and has no file source; the VS-Code-style namespace was chosen and extended with `file:`.

**CFG-3 — Precedence & env.** Effective value = config file (after substitution) → fallback env (only when the key is absent from the file: `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `DATABASE_URL`) → schema default. Env-only bootstrap variables (never in files): `IDP_CONFIG_DIR`, `HOST`, `PORT`, `LOG_LEVEL`, `LOG_FORMAT`, `IDP_MIGRATE_ON_BOOT`. There is **no** generic `IDP__SECTION__KEY` override mechanism.

**CFG-4 — Key inventory.** (type · default · req = required)

| Key | Type | Default | Notes |
|---|---|---|---|
| `server.baseUrl` | url | — **req** | Issuer; scheme+host[:port]+optional path, no trailing slash; https required in production (= non-localhost https rule below). |
| `server.host` / `server.port` | string/int | `0.0.0.0` / `3000` | Also env `HOST`/`PORT`. |
| `server.trustProxy` | bool \| CIDR[] | `false` | Honour `X-Forwarded-*` from the immediate upstream / listed ranges (rightmost-untrusted-hop). |
| `server.trustedOrigins` | url[] | `[baseUrl]` | CSRF origin allow-list. |
| `server.allowInsecureHttp` | bool | `false` | Permit non-https `baseUrl` outside localhost (dev only). |
| `server.shutdownTimeoutSeconds` | int | `10` | |
| `secret` | string | — **req** | ≥ 32 random bytes; fallback env `BETTER_AUTH_SECRET`; placeholder-only in production. |
| `database.url` | string | — **req** | Postgres connection string; fallback env `DATABASE_URL`; `sslmode` honoured. |
| `database.directUrl` | string | — | Connection string for every step that takes a **session advisory lock** — startup, migrations, `idp *`, the cleanup job. **Required when `database.url` points at a transaction-mode connection pooler** (Neon `-pooler`, PgBouncer): session locks do not hold through one (verified, S4/D27). Fallback env `DIRECT_DATABASE_URL`; startup warns when the URL looks pooled and this is unset. |
| `database.schema` | string | `idp` | All IdP tables + drizzle migrations table live here; created on migrate; nothing in `public` (Q16, risk R8). Resolved at **runtime**: the Drizzle tables are built from this value and the migrator retargets the schema identifier in the committed SQL. |
| `database.ssl` | enum | `require` off-localhost | `disable\|require\|verify-full`; overrides URL `sslmode` when set; `database.sslCa` (PEM or `${file:}`). |
| `database.poolMax` | int | `10` | + `database.connectTimeoutSeconds`. |
| `database.migrateOnBoot` | bool | `true` | Also env `IDP_MIGRATE_ON_BOOT`. |
| `site.name` | string | — **req** | Branding; also TOTP issuer default. |
| `site.logo` / `site.favicon` | path/url | — | Under `branding/` or URL. |
| `site.supportEmail`, `site.termsUrl`, `site.privacyUrl` | string | — | |
| `site.theme` | enum | `system` | `system\|light\|dark` (built-in only). |
| `site.defaultLocale` | string | `en-US` | FR-I18N-1. |
| `email.resend.apiKey` | string | — | Absent ⇒ degraded mode (FR-MAIL-2); placeholder. |
| `email.from` | string | req when e-mail on | `email.replyTo` optional. |
| `signUp.enabled` | bool | `false` | FR-SIGNUP-1. |
| `signUp.requireApproval` | bool | `true` | FR-SIGNUP-2. |
| `signUp.allowedEmailDomains` | string[] | `[]` | FR-SIGNUP-3. |
| `auth.defaultRedirect` | string | `/account` | Where a completed sign-in lands when nothing more specific applies (FR-AUTH-1, D28). Either a **same-origin relative path** (starts `/`, not `//` or `/\`, no `://`) or an **absolute http(s) URL on any origin** — a bare hostname is rejected. This is operator configuration, not user input, so a cross-origin value is not an open redirect; **SEC-3 is unchanged** and the runtime `returnTo` parameter stays same-origin-relative-only. Set it when the IdP is bundled beside the product it signs users in to. |
| `auth.requireEmailVerification` | bool | `true` | Forced false when e-mail off; password sign-in only. |
| `auth.password.minLength/maxLength` | int | `12`/`128` | `auth.password.breachCheck` bool, default false. |
| `auth.passwordReset.tokenTtlMinutes` | int | `60` | Verification link TTL 24 h. |
| `session.expiresIn` / `session.updateAge` | dur | `7d` / `1d` | |
| `session.cookieCacheMinutes` | int | `5` | ≤ 5. |
| `session.freshAgeMinutes` | int | `15` | FR-AUTH-5. |
| `session.revokeOAuthTokensOnLogout` | bool | `false` | |
| `social.<provider>.*` | object | — | `enabled`, `clientId`, `clientSecret` (placeholder), `syncProfile` (true), `allowedEmailDomains`, provider options; `social.microsoft.tenantId` **required** (FR-SOC-5). |
| `twoFactor.enabled` | bool | `true` | `twoFactor.issuer` (default `site.name`), `twoFactor.trustDeviceDays` (30). |
| `apiKeys.enabled` | bool | `true` | `defaultExpiresIn` 365 d, `maxExpiresIn` 730 d, `tokenClientId` `"idp"`, `tokenTtl` 3600 s. |
| `jwt.algorithm` | enum | `ES256` | `ES256\|RS256` only. |
| `jwt.audience` | url \| url[] | — **req** | Default audience/resource (FR-OIDC-6); example = `baseUrl`. |
| `jwt.includeUserData` | bool | `true` | FR-OIDC-7. `jwt.userClaims` subset selector. |
| `jwt.claims` | object | `{}` | Static claims (FR-OIDC-8); `jwt.claimsInIdToken` bool, default false. |
| `jwt.rotationInterval` / `jwt.gracePeriod` | dur | `90d` / max-token-lifetime + 1 h | FR-OIDC-16. |
| `jwt.sessionToken.ttl` | int s | `3600` | FR-OIDC-14. |
| `oauth.accessTokenTtl` | dur | `15m` | `oauth.idTokenTtl` 1 h, `oauth.codeTtl` 60 s, `oauth.refreshTokenTtl` 30 d, `oauth.refreshTokenMaxLifetime` 90 d. (`oauth.m2mAccessTokenTtl` removed by D26.) |
| `oauth.scopes` | string[] | `[openid, profile, email, offline_access]` | Clients may only reference declared scopes. |
| `oauth.resources` | (url \| object)[] | `[]` | Optional extra resources: `{ identifier, name?, allowedScopes?, accessTokenTtl? }`. |
| `oauth.reconcile.prune` | bool | `false` | FR-OIDC-2. |
| `admin.adminRoles` | string[] | `["admin"]` | Must exist in the catalog. |
| `admin.bootstrap` | object | — | FR-ADMIN-1. `admin.allowImpersonation` bool, default false. |
| `rateLimit.enabled` | bool | `true` | `rateLimit.storage: "database" (default) \| "memory"`; per-endpoint rules (SEC-2). |
| `logging.level` / `logging.format` | enum | `info` / `json` | `json\|pretty`; env `LOG_LEVEL`/`LOG_FORMAT`. |
| `cleanup.intervalMinutes` | int | `60` | OPS-8. |
| `audit.retentionDays` | int | `90` | SEC-6. |

**CFG-5 — Validation.** All three files are validated together against zod schemas (exported as JSON Schema for editor IntelliSense); `additionalProperties: false`; **all** errors reported in one pass. Cross-checks (startup errors): duplicate `clientId`/role names · public client with secret / confidential without · secret < 32 chars · `type: "service"` or `client_credentials` in `grantTypes` (unsupported in v1, D26) · empty `redirectUris` on an authorization-code client · invalid/unregistered URIs · undeclared scopes/resources · missing or duplicate `default` role · `adminRoles` entry missing from the catalog · `jwt.algorithm` outside {ES256, RS256} · `tenantId` in {common, organizations, consumers} · **literal (non-placeholder) secrets in production** (production = https `baseUrl`) for `secret`, client secrets, social secrets, `email.resend.apiKey`. `idp config validate` prints the effective configuration with secrets masked and exits non-zero on failure. Configuration is read **once**; changes require a restart (no hot reload, SIGHUP ignored).

**CFG-6 — Secrets.** `secret` ≥ 32 random bytes (generation command documented); rotating it invalidates all sessions **and makes the AES-GCM-encrypted `jwks` private keys undecryptable** — the runbook (DOC-4) covers re-keying (`idp rotate-keys`) and notifying verifiers. Docker builds never receive secrets via `ARG`/`ENV`; images contain no secrets; `${file:}` supports Docker/K8s secret files; secrets never appear in logs (SEC-5).

---

## 7. Data model (DM)

**DM-1 — Authoritative schema.** Generated from the **installed** Better Auth's `getAuthTables()` for the enabled plugins by `apps/web/scripts/generate-auth-schema.ts`, not by the `auth` CLI (**D29**); custom fields are declared as Better Auth `additionalFields` and the custom `audit_log` table as the schema of a small **local Better Auth plugin**, so one pass emits everything (v0's "all ORM from the plugin set" holds). The two read the same source of truth and produce the same seventeen tables field-for-field; they differ only in the wrapper, and that difference is the point — the CLI emits module-level constants with the schema name baked in as a string literal, while a runtime `database.schema` (CFG-4, D27, DM-4) needs a `createAuthSchema(schemaName)` factory plus `CANONICAL_SCHEMA_NAME` for the migrator to retarget. Then `drizzle-kit generate` produces committed SQL migrations. CI fails on drift between the committed schema and a fresh generator run.

**DM-2 — Tables in scope.** `user`, `session` (keeps `impersonated_by`; drops `active_organization_id`), `account`, `verification`, `two_factor`, `rate_limit`, `jwks`, `oauth_client`, `oauth_refresh_token`, `oauth_access_token`, `oauth_consent`, `oauth_resource` + `oauth_client_resource` (1.7 names per generator), `apikey`, custom `audit_log`. **Out:** `organization`, `organization_role`, `member`, `invitation`, `subscription`, and `user.stripe_customer_id`.

**DM-3 — `user` columns (D13).** From the v0 reference, kept with these names: `id, name, first_name, last_name, email (unique), email_verified, image, created_at, updated_at, role, banned, ban_reason, ban_expires, two_factor_enabled` — plus custom `status` (`pending|active|rejected`), `approved_at`, `approved_by`, `must_change_password`. Claim mapping per FR-OIDC-7/§5.7.

**DM-4 — Schema placement.** Everything (including drizzle's migrations bookkeeping table) lives in `database.schema` (default `idp`); nothing in `public` (risk R8).

**DM-5 — Retention.** Expired sessions, verification rows, auth codes, expired/revoked tokens (> 30 d), stale rate-limit rows and retired JWKS keys past grace are purged by the cleanup job (OPS-8); `audit_log` rows per `audit.retentionDays`.

---

## 8. Security requirements (SEC)

**SEC-1 — Absolute URLs.** Every absolute URL (issuer, discovery, e-mail links, social callbacks, redirects, cookies) derives from `server.baseUrl` only — never from `Host`/`X-Forwarded-Host`. *AC:* host-header injection test (TST-5).

**SEC-2 — Rate limiting.** Enabled by default; storage `database` (survives restarts, replica-ready). Stricter documented rules for: sign-in, sign-up, forgot/reset password, verify e-mail, 2FA attempts, `/oauth2/token` (per client id **and** per IP), `/oauth2/authorize`, API-key verification. Client IP honours `server.trustProxy` (bool or CIDR list, rightmost-untrusted-hop); spoofed-header behaviour tested. 429s show retry-after without revealing thresholds.

**SEC-3 — CSRF & redirects.** Better Auth origin checks with `server.trustedOrigins`; every state-changing endpoint — including TanStack server functions — enforces them. Any `returnTo`/`callbackURL` parameter must be a same-origin relative path; OAuth redirects only to registered URIs (FR-OIDC-3/4).

**SEC-4 — Headers.** HTML: CSP without third-party hosts, `frame-ancestors 'none'` / `X-Frame-Options: DENY` (login/consent clickjacking), `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`; HSTS when https (app or Caddy — documented). `/oauth2/token`, `/oauth2/userinfo`, `/oauth2/introspect`: `Cache-Control: no-store`.

**SEC-5 — Logging & redaction.** Structured JSON to stdout with request id, method, path, status, duration, anonymized IP. Never logged: passwords, tokens, authorization codes, secrets, reset/verification links, `Authorization`/`Cookie` headers, `/oauth2/*` and `/api/auth/*` query strings. Log level/format per config.

**SEC-6 — Audit log.** Append-only `audit_log` table (actor, target, action, outcome, ip, ua, requestId, metadata, createdAt) **and** stdout events for: sign-in success/failure, sign-up, verification, approval/rejection, ban/unban, role change, password change/reset (requested/completed), session revocation, 2FA enrol/disable/reset, API-key create/revoke/failure, impersonation start/stop, consent grant/revoke, token issuance (`client_id`, `sub`, scopes), token revocations, client reconciliation diffs, key rotation, `social.profile_conflict`. Browsable at `/admin/audit`; retention `audit.retentionDays`; no secrets stored.

**SEC-7 — Anti-enumeration.** Uniform responses for forgot-password, resend-verification and sign-in failures; sign-up enumeration mitigated by rate limits and (when e-mail is on) verification-first flow; documented residual risk.

**SEC-8 — Self-contained runtime.** No third-party origins at runtime besides Postgres, Resend and enabled social providers: fonts and assets bundled; CSP allows no external hosts; egress needs documented (DOC-4).

**SEC-9 — Supply chain.** All dependencies pinned exactly (no `latest`), committed lockfile, `pnpm audit` in CI (nightly), image scanned (Trivy) with SBOM attached; base image pinned by digest.

**SEC-10 — Better Auth security defaults respected.** Password hashing = Better Auth default (scrypt); `storeClientSecret: "hashed"`; JWKS private keys encrypted at rest; no debug endpoints in production.

---

## 9. Operations (OPS)

**OPS-1 — Image.** Multi-stage build from pinned `oven/bun:<version>-slim`; `pnpm install --frozen-lockfile`; final stage: production output only, non-root user, read-only root filesystem, `/config` mounted read-only, only `/tmp` writable, `TZ=UTC`; amd64 + arm64. Tags: `X.Y.Z`, `X.Y`, `X`, `latest`, immutable `sha-<git>`; OCI labels; `CHANGELOG.md`; migrations applied automatically on upgrade; no downgrade support ("back up before upgrading").

**OPS-2 — Startup sequence.** load + validate config → connect DB → migrate (when `database.migrateOnBoot`) → ensure signing key → reconcile clients/resources → validate roles vs. DB → bootstrap admin → listen → ready. Every shared-state step runs under a Postgres advisory lock (replica-safe; single instance is the supported topology). Any failure exits non-zero with **one** actionable error.

**OPS-3 — Health.** `GET {baseUrl}/healthz` (alive, version) and `GET {baseUrl}/readyz` (config loaded, DB reachable, migrations current, signing key present): unauthenticated, excluded from rate limiting and request logs, non-revealing. Dockerfile `HEALTHCHECK` calls `http://127.0.0.1:$PORT{path}/healthz` via Bun (no curl in slim images).

**OPS-4 — Shutdown.** On SIGTERM/SIGINT: stop accepting, drain ≤ `server.shutdownTimeoutSeconds` (10 s), close pool, exit 0; Bun runs as PID 1; compose sets `stop_grace_period`.

**OPS-5 — Migrations.** Dev chain per DM-1. Runtime: `migrate()` on boot under advisory lock (default) or explicitly via `idp migrate`; forward-only.

**OPS-6 — Operator CLI.** `idp config validate` · `idp migrate` · `idp reconcile-clients` · `idp create-admin` · `idp rotate-keys` · `idp cleanup` · `idp version` — all runnable as `docker run <image> idp <cmd>` against the same config folder/env.

**OPS-7 — Reference deployment.** `docker-compose.yml`: pinned Postgres (16/17), named volume, healthchecks, `depends_on: condition: service_healthy`, `./config:/config:ro`, `env_file`, `secrets:`; optional **Caddy** profile (automatic HTTPS; Caddyfiles for host-root **and** sub-path incl. the origin-root RFC 8414 route). No Mailpit (Resend-only); dev/test e-mail uses the capture transport.

**OPS-8 — Cleanup.** In-process job every `cleanup.intervalMinutes` (jitter + advisory lock) purging per DM-5; `idp cleanup` on demand; counts logged.

**OPS-9 — Proxy & reachability.** Reference Caddyfile ships; `server.trustProxy` must be enabled behind it; `/.well-known/*` and the JWKS URL must be reachable over public https for Neon; social callbacks require browser reachability of `baseUrl`. Standalone plain-HTTP only with `server.allowInsecureHttp` (dev).

**OPS-10 — Sub-path deployment (D2).** `baseUrl` may carry a path; all routes, assets, cookies (`Path`), e-mail links, callbacks and discovery honour it; Caddy proxies `{path}/*` **without stripping** and adds the origin-root RFC 8414 route. (Risk R3.)

**OPS-11 — Single instance.** v1 is documented and tested single-instance; because all mutating startup steps take advisory locks and rate limiting is DB-backed, accidental replicas are safe but unsupported.

**OPS-12 — Backups.** Out of scope; README states that `jwks` holds the (encrypted) signing keys and that losing the DB or `secret` invalidates every issued token (verifiers must refetch the JWKS after re-keying).

**OPS-13 — Footprint targets.** Idle RSS < 256 MB; ready < 5 s excluding migrations; final image < 300 MB — measured in the CI smoke test.

---

## 10. Testing requirements (TST)

**TST-1 — Layers & gates.** Unit (Vitest) · integration against **real Postgres** (testcontainers or CI service container — PGlite is not a substitute for the postgres driver) · e2e (Playwright) against the **built Docker image** (real Bun runtime) with the capture-transport for e-mail · container smoke test. Turbo tasks `test`, `test:integration`, `test:e2e`; CI (GitHub Actions) on every PR: lint, typecheck, unit, integration, e2e, docker build + smoke, schema drift (DM-1), example-config validation, nightly `pnpm audit` — all required for merge. Coverage: ≥ 85 % for config/claims/reconcile/approval modules, ≥ 70 % overall. Deterministic seeds; fresh schema per integration file; `config.test/` fixtures.

**TST-2 — Unit scope.** Config loader (schema errors, unknown keys, aggregated reporting, JSONC, `$schema` exemption), placeholder grammar (env/file/defaults/escape/coercion/unresolved/no-recursion/un-namespaced rejection), client + role validation rules (every CFG-5 cross-check), role catalog compilation, claims builder (FR-OIDC-7/8 permutations), approval state machine.

**TST-3 — Lifecycle integration.** Sign-up with approval on (pending → login refused → approve → login) and off; sign-up disabled (4xx + hidden UI + social refusal); verification (capture transport, expiry, resend); reset (reuse refused, sessions + OAuth tokens revoked); banned user (login + refresh + API key refused); admin flows (create/edit/roles/ban/approve/reject/revoke/delete/2FA reset); bootstrap idempotency; reconciliation (create/update/secret change/disable/prune/invalid file aborts; CRUD endpoints denied); 2FA (enrol, login, backup code, trust device); API keys (create/use/expire/revoke/exchange).

**TST-4 — Protocol integration.** Discovery correctness at root **and** sub-path (issuer equality, endpoints, S256, alg, `ui_locales_supported`); full code+PKCE flow **without `resource`** → JWT with `aud = jwt.audience`, verified via `jose` `createRemoteJWKSet` (alg ES256, `kid`, `iss`, `aud`, `exp`, `sub`, user claims, `roles`, static `role` when configured); explicit allowed/disallowed `resource`; ID-token claim set by scope; userinfo; refresh rotation + reuse detection; revocation; introspection authz; end-session (hint/no-hint); `client_credentials` rejected with `unsupported_grant_type` and absent from discovery (D26); session-JWT and API-key-JWT paths (same claims); **Neon constraints test** (ES256/RS256, `kid` header, `use: sig`, `sub`, `exp`); JWKS rotation grace behaviour; full RP login through a minimal sample relying party (`openid-client`) kept in the repo.

**TST-5 — Security tests.** Approval gate on every path; mass assignment (FR-AUTH-7); redirect-URI mismatch renders error without redirect; PKCE downgrade rejected; wrong/missing client secret; public client sending `client_secret_*`; code replay revokes; CSRF origin checks incl. server functions; `/admin/*` and admin API reject non-admins; rate limits trigger (incl. spoofed `X-Forwarded-For` in standalone mode); host-header injection changes nothing; uniform forgot-password responses; last-admin protection; impersonation off by default; cookies carry the FR-AUTH-5 attributes.

**TST-6 — E2E (Playwright).** Login (success/failure/banned/pending), sign-up on/off, verification + reset via capture transport, 2FA enrol + challenge, consent approve/deny, end-session, account page (password change, sessions, API keys), admin (list/search/pagination, approve/reject, roles, ban), complete OIDC login via the sample RP — run at host root **and** behind Caddy under a sub-path; axe checks with zero serious/critical violations on every page.

**TST-7 — Social & release checks.** Automated social path via a mock OIDC provider in test config; documented manual checklist against Google/GitHub/Entra before each release; release checklist item: validate one real token against a real Neon project.

**TST-8 — Container smoke test.** Compose up → `/readyz` → discovery + JWKS fetch → one login → one token issuance → SIGTERM → clean exit code; asserts OPS-13 targets.

---

## 11. Documentation requirements (DOC)

**DOC-1 — README** (replaces the template text): what it is + non-goals · features **and benefits** · architecture (IdP, Postgres, Caddy, client apps, Neon as verifier) · quick start with docker compose (generate secret, bootstrap admin, first login — executed in CI so it cannot rot) · configuration reference **generated from the zod schemas** (CI fails when stale) · `oauth_clients.json` / `roles.json` references with examples · well-known endpoint list · reverse proxy & sub-path guide (Caddyfiles) · e-mail (Resend) setup · social provider setup with exact callback URLs (incl. Entra tenant requirement) · security notes · operations runbooks (DOC-4) · troubleshooting (`invalid_redirect_uri`, issuer mismatch, EdDSA-rejected-by-Neon, secure cookies over http, unresolved placeholders, migration lock, Resend failures) · development & testing · versioning/changelog · license.

**DOC-2 — Neon guide.** JWKS URL to register ( `{baseUrl}/api/auth/jwks` ), required algorithm (ES256/RS256), `sub` → `auth.user_id()`, the `roles` array vs. static `role: "authenticated"` claims, audience configuration (`jwt.audience` ↔ Neon's expected audience; Neon checks `aud` only when configured), public JWKS reachability, key-rotation grace vs. Neon's ≤ 1 h JWKS cache, revocation caveat (FR-OIDC-12), a minimal RLS policy example.

**DOC-3 — Client registration guide.** Worked examples: public SPA (PKCE, `none`), confidential server app (`client_secret_basic`), first-party app (session JWT), generic `openid-client` setup — plus an explicit note that machine-to-machine (`client_credentials`) is not supported in v1 and that a per-user API key (FR-KEY-3) is the v1 answer for scripted access — each with its `oauth_clients.json` entry, secret placeholder, and how the default audience / explicit `resource` works.

**DOC-4 — Runbooks & supporting files.** Upgrade (pull, migrate-on-boot, rollback policy) · key rotation · `secret` rotation (CFG-6 consequences) · client reconciliation · cleanup · reading audit logs · egress requirements. Files: `SECURITY.md` (disclosure contact), `CONTRIBUTING.md` (pnpm/Bun/CLI-generate/migrations/test commands), `CHANGELOG.md`, `config.example/`, sample Caddyfiles, compose file.

---

## 12. Decision log

### 12.1 Owner decisions (2026-08-23)

| # | Decision | Landed in |
|---|---|---|
| D1 | Better Auth latest (1.7.1 at spec time); v0 schema = names only | §4, DM-1 |
| D2 | Sub-path deployment required | OPS-10, FR-OIDC-15, TST-4/6 |
| D3 | "API key" = both `client_credentials` and per-user keys | FR-OIDC-1, FR-KEY — **superseded by D26**: v1 has per-user keys only |
| D4 | 2FA (TOTP) in v1, optional per user | FR-2FA |
| D5 | Roles = catalog only; admin area admin-only; roles are claims | FR-ROLE |
| D6 | Files are source of truth; DB rows are the reconciled operative store | FR-OIDC-2 |
| D7 | Always JWT access tokens, Neon-valid; ES256 default | FR-OIDC-5/6 |
| D8 | No account linking; identity = provider subject; providers via config | FR-SOC |
| D9 | Consent optional; file clients skip by default | FR-OIDC-10 |
| D10 | Resend API key; absent ⇒ e-mail features disabled | FR-MAIL |
| D11 | Sign-up: global, default off; approval default on | FR-SIGNUP |
| D12 | Bootstrap admin in config.json via env placeholders | FR-ADMIN-1 |
| D13 | v0 user columns kept; user data in JWT by default | DM-3, FR-OIDC-7 |
| D14 | Custom static claims via config (`role: "authenticated"`) | FR-OIDC-8 |
| D15 | OAuth tokens cleared on password change (+ ban/reject/delete) | FR-OIDC-12 |
| D16 | Audience via config.json | FR-OIDC-6 |
| D17 | i18n prepared, en-US only | FR-I18N |
| D18 | `${env:NAME}` placeholder grammar | CFG-2 |
| D19 | `database.url` + `database.schema` (default `idp`) | CFG-4, DM-4 |
| D20 | Access-token claim set (from the owner's token doc; ES256 instead of EdDSA) | FR-OIDC-7 |
| D21 | Ban kept (OOTB feature) | FR-ADMIN-4 |
| D22 | Entra identity via `oid`; tenantId mandatory | FR-SOC-2/5 |
| D23 | Logout endpoint clears cookie; first-party = same-host client | FR-AUTH-6, FR-OIDC-14 |
| D24 | Social profile-sync e-mail collision **blocks the sign-in** (neutral refusal + `social.profile_conflict`), rather than silently skipping the update | FR-SOC-4 |
| D25 | **No** startup warning for "social enabled while sign-up off"; the "unverified open registration" warning stays | FR-SIGNUP-4 |
| D27 | **`database.directUrl`** added: every advisory-locked step (startup, migrations, CLI, cleanup) uses it, and it is required whenever `database.url` is a transaction-mode pooler. Forced by spike S4, which showed session locks do not hold through Neon's `-pooler` endpoint while they do through the direct one | CFG-4, OPS-2/5/8, §13 R8 |
| D28 | **`auth.defaultRedirect`** added (default `/account`): the post-sign-in destination is operator-configurable as a same-origin relative path or an absolute URL on any origin, sitting third in the FR-AUTH-1 precedence behind an OAuth continuation and a validated `returnTo`. Forced by review finding R-3 — the destination was hard-coded to `/account`, which is wrong whenever the IdP is bundled beside its product, and 404s until M7 ships. The resolver also governs password-change completion, since an absolute default cannot survive the `returnTo` round trip FR-AUTH-4 relies on. SEC-3 unchanged | FR-AUTH-1, FR-AUTH-4, CFG-4, SEC-3 |
| D29 | The Drizzle schema stays generated by `apps/web/scripts/generate-auth-schema.ts` rather than the Better Auth CLI, and the recorded justification is corrected. The old reason — a CLI "version-stranded at 1.4.21" — was **false**: `@better-auth/cli` is deprecated and the CLI was renamed to `auth`, which publishes 1.7.1 against `better-auth@1.7.1` and `@better-auth/core@1.7.1`, our exact pins. Run against a shim of our own option set it emits the same 17 tables, and after two defects it exposed were fixed the two outputs are field-, index- and FK-identical. It survives for a structural reason instead: the CLI emits module-level constants with the schema name baked in as a string literal, and a runtime `database.schema` (D27) needs a `createAuthSchema(schemaName)` factory the CLI has no code path to produce | §4, DM-1, R-2 |
| D32 | **`aud` on an access token is an array containing `jwt.audience`, not the bare string.** Spike S1 planned to normalise it away in the `jwt.sign` seam; 1.7.1 makes that impossible — the `jwt` plugin *refuses to construct* with `jwt.sign` unless `jwks.remoteUrl` is also set (`index.mjs:24`), which would move the whole key set off this deployment. With `scope=openid` the provider always appends its own `{authBaseUrl}/oauth2/userinfo` as a second audience and offers no option to suppress it, so a conformant token carries both values. Every RFC 7519 §4.1.3 verifier — `jose`, Neon, PostgREST — checks `aud` by membership, so nothing downstream changes; FR-OIDC-6's acceptance criterion is read as "the token's audience **includes** `jwt.audience`". The alternative was patching `@better-auth/oauth-provider`'s `resolveResourcePolicy`, which was judged the worse trade for a claim shape that is already correct | FR-OIDC-6, S1, R1 |
| D33 | **The interrupted authorization needs no server-side store.** FR-OIDC-9 was planned around the `pending_authorization` table plus a host-only handle cookie. `@better-auth/oauth-provider@1.7.1` already carries the whole authorization request in the interstitial page's query string, signed with the server secret and stamped with an expiry, and re-runs it from `POST /oauth2/continue`. The table stays in the generated schema — removing it would be a migration for no gain, and M12's cleanup job purges it either way — but nothing writes to it. This deployment still *drives* the resume rather than letting the provider's automatic after-hook do it: that hook fires whenever a request carrying the signed query sets a session cookie, which would hand an authorization code to a user with a temporary password before FR-AUTH-4's forced change | FR-OIDC-9, FR-AUTH-4 |
| D34 | **The last-administrator rule is checked before the self-action rules.** When both fit, "give another account an admin role first" is the answer, not "ask another administrator". The ordering was the other way round for a day, on the reasoning that the self message is more actionable — which is exactly backwards: with two administrators the last-admin rule never applies, so that message was only ever shown to the one person who had nobody to ask | FR-ADMIN-3, FR-ROLE-3 |
| D35 | **An admin endpoint accepts a session built by the api-key plugin.** `getAuthoritativeSessionFromCtx` re-reads the session row past the cookie cache by nulling `context.session` and reading the cookie again, so an API-key caller — who has no cookie — was answered 401 by every administrative endpoint, making the documented management interface of FR-ADMIN-6 unreachable to its intended callers. The gate now falls back to the session the hooks resolved. That session is not the staler of the two: the FR-KEY-2 gate re-reads the owner's standing on every use, sooner than any cookie session is re-checked | FR-ADMIN-6, FR-KEY-2, FR-AUTH-5 |
| D31 | **The site does not need to work without JavaScript.** Progressive enhancement stays where it is free — the public pages are still plain server-rendered `<form method="post">`, so the first paint is correct before hydration — but no feature has to remain usable with scripting off, and R-1's "still works with JavaScript disabled" acceptance criterion is withdrawn. Prompted by the measurement under R-1: Chromium and WebKit clamp `-webkit-text-security` back to `disc` on a password field, so the scriptless reveal the code claimed only ever worked in Firefox | FR-ACCT-2, R-1 |
| D26 | **No machine-to-machine support in v1**: the `client_credentials` grant, the `service` client type, `clientCredentialsScopes` and `oauth.m2mAccessTokenTtl` are removed; "API keys" = per-user keys (FR-KEY) only | §1.2/1.3, §2, §3, FR-OIDC-1/3/7, CFG-4, CFG-5, SEC-6, TST-4, DOC-3, supersedes D3 |

### 12.2 Q&A resolutions (owner, 2026-08-23)

| # | Question (abridged) | Resolution |
|---|---|---|
| Q1 | DB as derived mirror vs. no client rows at all | Derived mirror (FR-OIDC-2) |
| Q2 | JWT claim naming | Owner's token doc → standard OIDC names + `roles[]` + static `role` (FR-OIDC-7) |
| Q3 | `roles` array; `role` reserved for static claim | Yes (FR-ROLE-2) |
| Q4 | Drop `stripeCustomerId`; ban OOTB? | Dropped; ban is OOTB → kept (FR-ADMIN-4) |
| Q5 | Profile sync; correct Entra claim vs. e-mail takeover | Sync per provider; identity = `oid`; takeover impossible (FR-SOC-2/4) |
| Q6 | E-mail collision without linking | No linking at all; reject (FR-SOC-2) |
| Q7 | Resend only | Yes (FR-MAIL-1) |
| Q8 | E-mail off + sign-up on | Unverified badge; approval gate stands (FR-MAIL-2) |
| Q9 | `jwt.audience` example default | Required; example = `baseUrl` (CFG-4) |
| Q10 | Session-JWT endpoint; logout; first-party definition | Enabled; `sign-out` clears cookie; first-party = same host (FR-OIDC-14, FR-AUTH-6) |
| Q11 | Impersonation | Optional, default off (FR-ADMIN-5) |
| Q12 | API-key defaults 365 d / 730 d | Accepted (FR-KEY-1) |
| Q13 | Extra access-token claims | `roles[]` yes; `email_verified` no; `picture` no (FR-OIDC-7) |
| Q14 | API-key JWT via `GET /api/auth/token` + `x-api-key` | Accepted (FR-KEY-3) |
| Q15 | Entra tenantId mandatory | Yes; `common` rejected (FR-SOC-5) |
| Q16 | Migrations table inside `idp` schema | Yes (DM-4) |

**Audit defaults — owner sign-off (2026-08-23), all five resolved:**

| Audit default | Resolution |
|---|---|
| (a) `jwt.claims` default `{}` — static `role` only when configured (FR-OIDC-8) | **Confirmed as written.** |
| (b) exact `includeUserData`/`userClaims` semantics (FR-OIDC-7) | **Confirmed as written.** |
| (c) profile-sync conflict = skip update, keep sign-in (FR-SOC-4) | **Overruled → D24**: the sign-in is blocked. |
| (d) startup warning for social-enabled-while-sign-up-off (FR-SIGNUP-4) | **Overruled → D25**: no warning. |
| (e) `client_credentials` tokens carry no `roles` (FR-OIDC-7) | **Moot → D26**: no `client_credentials` in v1. |

### 12.3 Verified facts the spec relies on (2026-08-23)

V1 Better Auth latest = 1.7.1 · V2 no per-entity repository seam, no roles table, no static-client option, token tables FK → `oauth_client.client_id` · V3 access token is a JWT **only** when an audience/resource resolves; reserved claims cannot be overridden; `accessTokenJWT` no longer exists in 1.7 · V4 JWT plugin defaults EdDSA, supports ES256/RS256; keys encrypted with `secret`; rotation + grace options · V5 **Neon validates RS256/ES256 only**, requires `kid`, checks `aud` only when configured, caches JWKS ≤ 1 h · V6 admin plugin has ban/impersonation/CRUD, no approval · V7 account linking on by default, can be fully disabled · V8 1.7 client fields incl. `clientCredentialsScopes` (unused in v1 per D26); first-class resources with seeding and per-client links (inventory re-check = R9) · Entra provider keys accounts on `profile.oid` (1.7.1 source).

---

## 13. Implementation risks (verify in an early spike; each is referenced from its requirement)

| # | Risk | Fallback |
|---|---|---|
| R1 | Injecting the default audience (`jwt.audience`) as the `resource` when the client sends none — via Better Auth `hooks.before` on `/oauth2/authorize` + `/oauth2/token` or an equivalent supported mechanism. | **Pre-authorized (owner, 2026-08-23):** if hooks cannot do it, apply and maintain a `pnpm patch` of Better Auth. No re-escalation needed. (The "require clients to send `resource`" fallback is *not* acceptable — it violates FR-OIDC-5 for naïve clients.) |
| R2 | `enforcePerClientResources` defaults true → reconcile must create `oauth_client_resource` links for the default + per-client audiences. | Set the option false. |
| R3 | Sub-path: TanStack Start `base` / router `basepath` / Better Auth `basePath`+`baseURL` / cookie `Path` must agree; origin-root RFC 8414 route via Caddy. | None — D2 is a hard requirement; spike first. |
| R4 | Reconcile must hash client secrets exactly as Better Auth does (`storeClientSecret: "hashed"`). | Drive create/update through Better Auth's own server-side API instead of direct writes. |
| R5 | Session-JWT endpoint (`definePayload`) must produce the FR-OIDC-7 claim set. | Custom endpoint using the shared claims builder + jwt plugin signing. |
| R6 | Approval/2FA/forced-change/consent continuation order with the pending authorize request held ≤ 10 min; async approval never resumes the flow. | — (design constraint; verify hooks support it). |
| R7 | Profile sync without linking (update on `(providerId, accountId)`; collision skips update only) implementable via Better Auth hooks. | Custom post-sign-in sync step. |
| R8 | `database.schema`: postgres driver `search_path` + drizzle-kit `migrationsSchema` keeps CLI output untouched and everything in `idp`. | Post-process generated schema to `pgSchema()`. |
| ~~R8~~ | **Closed by spike S4 (2026-08-23).** `search_path` is *not* a workable mechanism: Neon's pooled endpoint silently drops the startup parameter. Resolved instead by generating schema-qualified tables from a factory taking `database.schema`, plus a migrator that retargets the schema identifier — see `docs/spikes/s4-schema-placement.md`. The same spike found session advisory locks do **not** hold through the pooler, which is why `database.directUrl` exists (D27). |
| R9 | V8 client-field/option inventory read from `main` — re-verify against the installed 1.7.1 types before freezing the client JSON schema. | Adjust the schema mapping. |
| R10 | Confirm auto-emitted claims (`jti`, `client_id`, `azp`, `sid`), the exact reserved list and the `customAccessTokenClaims` context (session/client available). | Add missing claims via a token-response hook. |
| R11 | JWKS rotation publishes the new key before it signs. | Rotate = create + publish now, sign after a propagation delay ≥ Neon's 1 h cache. |

---

## 14. Traceability (spec-v0 → v1)

| v0 statement (line) | v1 requirements |
|---|---|
| Lightweight IdP as Docker container; pluggable user management; JWT/JWKS for internal apps "like Neon"; lean, secure, self-contained (1) | §1, §3, FR-OIDC-5/15/16, FR-ADMIN-6, SEC-8, OPS-1 |
| Bun, TanStack Start, shadcn/base-ui, Drizzle/Postgres, pnpm, monorepo, Better Auth latest (3) | §4 |
| Manage users & roles; OIDC/OAuth2 endpoints; single tenant, no organizations (5) | FR-ADMIN, FR-ROLE, FR-OIDC-4, §1.3, DM-2 |
| Login UI; social sign-ins (Google/GitHub); password reset; sign-up option; approval option (7) | FR-ACCT-2, FR-SOC, FR-AUTH-3, FR-SIGNUP |
| Admin plugin, api key (9) | FR-ADMIN, FR-KEY (per-user keys only — D26 removed `client_credentials`) |
| User-facing UI with login & reset pages (11) | FR-ACCT-2 |
| Admin UI: manage users and roles, approve users (13) | FR-ADMIN-2, FR-ROLE-2 (assign; definitions via file), FR-SIGNUP-2 |
| oauth_client & role config files; env substitution `${env:…}`; container configured at build (15) | FR-OIDC-2/3, FR-ROLE-1, CFG-1/2 (runtime substitution; baked non-secret config allowed, secrets env-only — CFG-6) |
| Generic config.json (secret, site name, everything) (17) | CFG-4 |
| Standalone or behind Caddy; no fixed path expectations (19) | OPS-9/10 (sub-path required per D2) |
| Common well-known files (21) | FR-OIDC-15 |
| Automated tests (23) | §10 |
| Docker container (25) | OPS-1..13 |
| README with features/benefits/config (27) | §11 |
| Schema: reuse table/field names, only what's needed, ORM via Better Auth CLI (29) | DM-1..3 |

---

## 15. Sign-off checklist (before deriving the implementation plan)

- [x] Owner confirms the five audit defaults (§12.2) — (a) and (b) confirmed, (c) overruled by **D24**, (d) overruled by **D25**, (e) moot under **D26**.
- [x] Owner confirms the R1 fallback policy — a maintained `pnpm patch` of Better Auth is **pre-authorized** (§13, R1).
- [x] Walk-throughs in the plan's verification checklist re-run against **this** document.
- [x] Implementation plan derived; risks R1–R3 and R8 are spiked first (M0).

**Spec signed off 2026-08-23.** Any later change to a numbered requirement is a spec amendment recorded in §12 and `CHANGELOG.md`.
