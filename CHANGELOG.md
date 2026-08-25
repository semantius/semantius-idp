# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Decisions that changed a numbered requirement carry their `D` number from
[spec-v1.md](spec-v1.md) §12, where the reasoning is.

## [Unreleased]

The first release has not been cut. Everything below is what v1.0.0 will
contain.

### Added

- **OAuth 2.1 / OpenID Connect provider.** Authorization code with mandatory
  PKCE (S256 only) and refresh tokens with rotation and reuse detection.
  Discovery, JWKS, userinfo, introspection, revocation and RP-initiated logout,
  all at the issuer root and all working under a sub-path.
- **Always-JWT access tokens**, ES256 by default, so a resource server
  validates them offline against the published key set. A default audience is
  applied when a client asks for no `resource`, which is what makes a naïve
  client's token valid for Neon without it knowing.
- **Password authentication** with sign-up, an approval queue, e-mail
  verification, password reset, and a forced first-password change for accounts
  an administrator created.
- **Two-factor authentication** (TOTP) with backup codes and trusted devices.
- **Social sign-in** for Google, GitHub and Entra, without account linking: an
  identity is a provider subject, and an address that already belongs to
  another account is refused rather than merged.
- **Per-user API keys**, exchangeable for a JWT from the same claims builder —
  the v1 answer for scripted access, since there is no `client_credentials`
  grant.
- **An account area**: profile, password, e-mail address, sessions, API keys
  and connected applications.
- **An administration area and API**: users with search, filters and paging;
  approve, reject, suspend, delete, edit; roles as checkboxes from the catalog;
  sessions; API keys; OAuth clients — file-managed ones read-only, and
  registration, disabling and removal for ones added here (**D50**); a
  read-only view of roles; the audit trail, with actors and targets resolved to
  names; and a system page with the effective configuration, the signing keys
  and manual rotation.
- **A first-run setup page** (**D52**). A deployment with no users asks for the
  first one in the browser and signs them in as an administrator. There is no
  bootstrap account, no password in an environment file, and nothing to unset
  afterwards.
- **File-driven configuration.** `config.json`, `oauth_clients.json` and
  `roles.json` are the source of truth, parsed as JSONC with `${env:…}` and
  `${file:…}` placeholders, validated in one pass with every error reported
  together, and reconciled into the database at start-up.
- **A single container**, non-root and read-only, with the operator CLI in the
  same binary: `config validate`, `migrate`, `reconcile-clients`,
  `rotate-keys`, `cleanup`, `version`.
- **A reference deployment** in `docker/` (**D51**): compose with Postgres and
  health checks, Caddyfiles for both a dedicated hostname and a sub-path, and a
  `.cmd`/`.sh` pair per lifecycle verb — `idp-create`, `idp-start`, `idp-stop`,
  `idp-status`, `idp-logs`, `idp-cli`, `idp-destroy`. The environment contract
  is whole connection strings — `DATABASE_URL` and `DATABASE_URL_ADMIN`
  (**D48**) — with no secrets file and nothing assembled from a password.
- **Documentation**: a generated configuration reference, guides for Neon and
  for registering clients, and runbooks.

### Security

- Every absolute URL derives from `server.baseUrl` and never from a request
  header.
- Rate limiting on by default, stored in the database, with stricter rules for
  sign-in, reset, two-factor and the token endpoint — per client id as well as
  per IP.
- An append-only audit log of every security-relevant event, with a request id
  that ties a row to a log line.
- Uniform responses for forgot-password, resend-verification and sign-in
  failures.
- The last administrator cannot be demoted, suspended or deleted, and nobody
  can change their own roles.
- Content-Security-Policy with no third-party origin, `frame-ancestors 'none'`,
  and `form-action` limited to this origin plus the registered redirect origins
  — file-configured and enabled database clients alike (**D46**, **D50**).
- **No secret ever travels in a URL.** A generated API key, a set-password
  invite link and a new client secret each reach the browser through a
  server-side one-shot stash and are shown once, in a dialog; the redirect
  carries an opaque handle. A query string survives in browser history, in
  `Referer` and in every proxy log in between.
- **Destructive administrative actions confirm**, in the dialog that carries
  them.

### Fixed before release

The end-to-end suite, added last, found fourteen defects on its first complete
run. The ones that mattered:

- **The e-mail verification link did nothing.** It pointed at the page that
  reports the outcome rather than the endpoint that spends the token, so a
  self-registered account could never be verified — and with
  `auth.requireEmailVerification` on, could never sign in.
- **No OIDC login could resume through an interstitial.** The signed
  authorization request was re-serialised on its way through the sign-in page,
  which broke its own signature (FR-OIDC-9).
- **`form-action 'self'` made every OAuth login fail in Chrome**, which applies
  the directive to the redirect a form submission follows (**D46**).
- **RP-initiated logout could not complete at all**, in either of its branches
  (**D47**).
- **Revocation was not immediate on the IdP's own pages**: a cookie-cached
  session outlived "sign out everywhere else" by up to five minutes.
- **A suspended account was told its password was wrong**, and the page that
  explains a suspension was never given the reason it displays.
- **Pagination in the admin area did nothing** — the URL changed and the list
  did not.
- **Turning two-factor authentication on or off, and changing a password from
  the account area, sent no notification.**
- **Every confirmed e-mail address was recorded in the audit log as a
  failure.**

### Changed after the first owner review (2026-08-25)

The review before v1.0.0. Fourteen findings plus a security and
spec-completeness pass; the ones that changed a requirement carry a `D` number.

- **The environment bootstrap is gone**, and with it `idp reset-admin`
  (**D52**). Both existed to work around each other: a password in `.env` that
  survived exactly one sign-in, and a command to put it back when somebody
  forgot it. Lockout recovery is now a second administrator, the reset e-mail,
  or one documented SQL statement.
- **`DIRECT_DATABASE_URL` is now `DATABASE_URL_ADMIN`** (**D48**), a clean break
  with no alias. The docker `secrets:` file is gone and `POSTGRES_PASSWORD` is
  an optional knob of the bundled reference database.
- **Deployment files moved to `docker/`** with lifecycle scripts (**D51**).
- **The display name is derived from the first and last name** and is no longer
  an input anywhere; `site.nameFormat` chooses the order (**D49**).
- **OAuth clients can be registered from the admin area** (**D50**).
- **The audit page reads.** The actor and the target resolve to display names
  in one batched query per page, the target's type is shown, and the full ids
  are in tooltips. One writer that recorded an API-key revocation against the
  user rather than the key was corrected.
- **Two FR compliance gaps closed**: FR-ADMIN-2's "edit (name, e-mail, verified
  flag)" had no implementation at all, and FR-SIGNUP-5's first and last name
  were missing from admin create.

[Unreleased]: https://github.com/semantius/semantius-idp/commits/main
