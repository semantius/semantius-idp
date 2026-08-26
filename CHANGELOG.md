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

### Changed after the second owner review (2026-08-25)

The owner walked the running application — first-run setup, sign-in, the admin
area — and filed thirteen findings. One was a leak, most were defects, three
were questions, and one was "polish every page".

- **`database.directUrl` was printed with its password.** Masking is positional
  by design (a new secret key has to be added to the list, which is the review
  prompt), and the key added by **D48**/**D27** was never added to it — so
  `/admin/system` showed the direct connection string in full to any
  administrator's browser. Both database pointers now go through the
  password-only connection-string masker, which also learnt to mask a password
  that arrives as a query parameter (`?password=`, `?sslpassword=`) rather
  than in the userinfo. The per-provider `social.<provider>`
  passthrough keys stay positional by design.
- **The default password minimum is 10** (**D53**), and the two places that
  ignored `auth.password.minLength` now read it: the "at least N characters"
  hint hard-coded 12, and the admin "set a temporary password" field had no
  client-side constraint at all. The server always enforced the configured
  value.
- **The first-run wizard requires both names and asks for the password twice**
  (**D54**). The names fed a derived display name and were optional; the
  password had no confirmation on the one form in the application that cannot
  be reached a second time.
- **Every form says it is working.** Each mutation is a real form post
  followed by a 303, so between the click and the new document the page simply
  sat there — long enough on a cold container to look broken, and long enough
  to be clicked twice. `PendingForm`/`SubmitButton` now wrap all forty-one of them: a
  spinner on the control that was actually pressed, a double-submit guard, an
  announced busy state, and — on the shared `TextField`/`PasswordField`, which
  is every public auth page — fields that go read-only while the post is in
  flight. The admin forms' raw `Input`/`Textarea`/`NativeSelect`/`Checkbox`
  stay editable; they are behind a dialog that is about to be replaced anyway. The guard is
  a ref and the visual state is deferred by one animation frame, because the
  browser builds the form entry list *after* the submit handler returns — a
  synchronously-disabled submitter would have dropped `/consent`'s own
  `decision=allow`.
- **The two shell headers stopped mixing three kinds of control in one row.**
  "Your account" was an underlined anchor and "Sign out" a bare underlined
  button, beside six pill-tab navigation links. Both are ghost buttons now.
- **Timestamps render in the browser's locale and timezone**, which is what
  FR-I18N-1 always said and what neither half of the application did: the
  admin pages printed raw UTC in three different precisions, and the account
  pages ran `Intl` server-side against the *configured* locale under a comment
  asserting the opposite. One `<LocalTime>` with two variants replaces
  every one of them. The first paint stays a deterministic UTC string, labelled
  as such — formatting on both sides of hydration is how a page tears — and
  the full ISO value moves into `title`.
- **Admin-registered OAuth clients no longer all demanded consent.** The create
  handler sent `skipConsent: false` from a checkbox that did not exist, and a
  *defined* `false` overrides the schema default of `true` — so every client
  registered from the admin area contradicted FR-OIDC-3, and the setting was
  invisible in the list. The dialog gained the checkbox (checked by default),
  a post-logout-URI field the handler had been reading all along, and an
  "allow RP-initiated logout" checkbox. That last one defaults **off**: the
  client schema refuses `enableEndSession` with no post-logout URI, so the old
  always-false bug was accidentally load-bearing and turning it on by default
  would fail every plain create. The type list now leads with, and defaults
  to, single-page app, and the table shows whether consent is skipped.
- **The impersonation control is hidden when impersonation is off**, reversing
  the earlier choice to show it disabled and explained. FR-ADMIN-5 never asked
  for it to be visible, and a permanently dead button beside eight live ones
  reads as clutter rather than as a feature worth discovering. "You cannot
  impersonate yourself" is still a disabled button, because that is a fact
  about the row rather than about the deployment.
- **The system page lists the discovery URLs** (**D55**). It showed the issuer
  and left every well-known URL to be assembled from it by hand — which is
  exactly where a sub-path deployment goes wrong, because two metadata URLs
  are then correct and neither is guessable: OpenID Discovery appends its
  well-known segment, RFC 8414 §3.1 puts it in front of the path — and
  `Caddyfile.subpath` rewrites *both* origin-root spellings, because enough
  clients ask for the OpenID one too. All four are listed, the two origin-root
  ones labelled as the reverse proxy's, and `security.txt` appears only when
  the file exists. The signing-key label
  became "Active key ID": the page never showed key material, but the old
  wording read as though it did.
- **The design sweep.** The one-time-secret dialog pushed its copy button
  outside the popup: the row holding the value is a grid item, and a grid
  item's default `min-width: auto` refuses to shrink below its content, so an
  unbreakable `whitespace-pre` secret widened it past the dialog. The user
  detail page's Actions sidebar stretched to the main column's height and the
  grid distributed the surplus *between* the buttons — it is `self-start`
  inside a Card now, grouped by what each entry does to the account. Beyond
  that: fourteen hand-rolled card surfaces are gone, replaced by
  `AdminCard` (which also subsumes a local `Section` helper) or by the kit's
  `Card` directly; `AuthShell`, `AccountSection` and `Stat` moved onto the kit's
  Card; six hand-rolled selects became `NativeSelect`, the client textareas
  `Textarea`, the scope and trust-device checkboxes the kit `Checkbox`, and
  eighteen field groups the kit's `Field`. `AdminShell`'s own `Field` — a
  `<dt>/<dd>` pair — was renamed `DetailRow`, because two things called `Field`
  in one file is how a definition row ends up wrapping an `<input>`. Five
  registry components were added verbatim for it (`spinner`, `field`,
  `native-select`, `textarea`, `empty`) — and the same `shadcn add` run
  re-fetched `label` and `separator`, which `field` imports, moving a
  `"use client"` directive from the first to the second. That is registry
  output, not a hand-edit; it is recorded here so the next `add` does not look
  like it broke something. Dialogs also gained a height cap and
  a scrollbar: the registry popup is `fixed top-1/2 -translate-y-1/2` with
  neither, so a form taller than the viewport hung off both ends with its
  submit button unreachable — which is exactly what happened to the
  client-create dialog the moment it grew the fields it had been missing.
- **The roles page shows its last reconcile and its warnings**, which
  FR-ADMIN-2 had always required and nothing had ever rendered — the string for
  it existed, under the wrong section. The warnings are the roles-versus-
  database drift that start-up detects (a user holding a role `roles.json` does
  not define, which is silently dropped from their claims), which until now
  reached the log and nothing else. Deliberately *not* the configuration-load
  warnings: those are already on `/admin` and `/admin/system`, and a third red
  box would have buried the one warning this page can act on.

[Unreleased]: https://github.com/semantius/semantius-idp/commits/main
