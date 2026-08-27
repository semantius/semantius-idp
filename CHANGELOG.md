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
- **File-driven configuration.** `config.jsonc`, `oauth_clients.jsonc` and
  `roles.jsonc` are the source of truth, parsed as JSONC with `${env:…}` and
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

### Added after the second owner review (2026-08-26)

- **`pnpm drizzle:reset`** — drop this deployment's schema and everything in
  it, so the next `pnpm dev` or `pnpm docker:up` starts on a fresh database and
  serves the first-run setup page again (**D56**). Migrations are forward-only
  and there is no seed step, so removing the schema *is* the reset; the script
  aims that one statement with the configuration the app itself loads —
  `database.schema` on `database.directUrl`, never `public`, never anything
  else in the database. It prints the target — configuration folder, masked connection
  string, schema, table count — then asks `[y/N]` about that schema by name,
  sets `lock_timeout` so a still-running dev server gives a sentence instead of
  a hang, and takes `--yes`, `--schema <name>` and `--migrate`. It is a repository script and not an `idp` CLI command on
  purpose: the CLI ships inside the container.

### Fixed after the second owner review (2026-08-26)

- **A sign-in refused for its `Origin` no longer claims the password is wrong**
  (**D57**). Better Auth turns a post from an untrusted origin away before it
  looks at a credential; that refusal was unmapped, fell through to
  `invalid_credentials`, and the page said the e-mail and password combination
  was not correct — about a request in which no password was checked. It now
  has its own code and its own message, which names what is actually wrong:
  the browser is on an address `server.baseUrl` (or `server.trustedOrigins`)
  does not cover. Opening the default deployment on `127.0.0.1` instead of
  `localhost` is the whole of it, and it takes out the first-run wizard's
  automatic sign-in too, so the first account a deployment ever creates is the
  one it happens to.
- **The first-run wizard's button says "Create first admin account"** rather
  than "Create the first account", which named the ordinal and not the thing.
- **`pnpm drizzle:reset` says to *restart* a running app, and counts the
  connections that show one is** (**D58**). `lock_timeout` does not stop a
  reset under a live server — an idle connection holds no table lock — and the
  first-run gate memoises "setup is done" for the life of the process, so that
  server kept serving the sign-in page to somebody who had just emptied the
  database. The target block now reports other backends on the database
  alongside the table count.
- **A session that could not be read no longer looks like a session that is not
  there** (**D59**). `readSession` caught everything and answered "anonymous",
  so a database failure and a signed-out visitor were the same answer: the log
  said `Failed query: select … from "idp"."session"` and the screen showed an
  ordinary sign-in page. A refusal — expired, revoked, banned — still answers
  `null`; a driver or query failure, and any 5xx, now reach the error page.
- **`createServerFn().inputValidator()` → `.validator()`** in the seven server
  functions still on the deprecated alias, which warned on every dev start.

### Changed after the third owner review (2026-08-26)

- **The config files are `.jsonc`, and the generated schemas moved to
  `config-schema/`** (**D60**). Two halves of one complaint. The files are
  documented as JSONC and are full of comments, so an editor opening
  `config.json` marked every one of them as an error before reading a key; and
  `config.example/` mixed the three files an operator edits with three a
  generator owns, which matters because that folder is *copied* to make a
  deployment's `config/` — the copy of a generated file goes stale silently and
  the `--check` gate never sees it. The loader resolves each name `.jsonc`
  first and then `.json`, so a folder written before this keeps working; having
  both spellings of one file is refused, naming both, rather than resolved by a
  guess. Every message names the file as it is spelled on disk.
- **`site.adminTitle`** — the administration area can be called something
  other than the deployment (**D61**). `site.name` was one string doing four
  jobs, and a deployment is often *Semantius* to the people signing in and
  *User Manager* to the few who administer it. Optional, defaults to
  `site.name`, and branding only: it never reaches the TOTP issuer label, the
  e-mails or a token claim. It renders in the admin shell heading and the
  document title, which is all eight admin routes and nothing else.
- **Forms check what the browser can check, before posting** (**D62**). The
  three password-and-confirmation forms — `/setup`, `/reset-password`,
  `/change-password` — reported a mistyped confirmation the long way round: a
  POST, a 303 and a page that came back empty with the mismatch announced at
  the top as if the server had refused something. The check now happens on
  submit and shows inline under the confirm field, with focus moved to it. The
  server's identical check is untouched and still authoritative.
- **Registering an application validates in the browser, and a refusal no
  longer empties the form** (**D62**). The dialog now applies the same redirect
  URI rules `oauth_clients.jsonc` is validated against — absolute, no wildcard,
  no fragment, https unless loopback, private-use schemes for native apps only
  — inline against the field that is wrong, and refuses `enableEndSession`
  with no post-logout URI rather than posting a certain rejection. The rules
  live in `lib/client-rules.ts` and are shared with the zod schema; importing
  the schema into the browser would have passed the client-bundle gate while
  eroding the seam it stands for. What is left for the server to refuse — a
  duplicate id, a file-managed collision, a lost race — comes back with the
  dialog reopened and all twelve fields as they were.
- **Re-authenticating in the middle of a form no longer throws the form away**
  (**D63**). Every admin write needs a session fresher than fifteen minutes,
  measured from when the password was typed and deliberately not refreshed by
  activity — so a long look at the client-registration dialog could outlive it.
  The gate ran before the request body was read, so the submission was
  discarded and had to be retyped after signing in again. It now reads the body
  first and carries it across the bounce, and the sign-in page says so. The
  window is unchanged; a stale session is still prompted. Nothing is stashed
  for a caller with no session at all, and password-bearing actions keep no
  draft.
- **Creating a user is a dialog on `/admin/users`, and the default role starts
  ticked** (**D64**). `/admin/users/new` was a page whose only outcome was to
  come back to the list — where the other outcome of the same action, the
  one-time set-password link, already opened as a dialog. Both live on the list
  now, and the URL is gone rather than redirected: only that page linked to it.
  The pre-ticked default role changes no server behaviour; an untouched form
  always got `defaultRole`, and now it says so.
- **Changing a password from the account area is a dialog**, not a link to
  another page. Every other action on `/account/security` already was one. The
  standalone `/change-password` page stays, because it is also the
  forced-change page (FR-AUTH-4) and what `/.well-known/change-password`
  redirects to — the two share their fields and the rules behind them
  (`server/auth/change-password.ts`), so there are not two forms to keep in
  step. A refusal reopens the dialog with the message beside the fields; the
  passwords themselves are not restored.
- **Three small things the owner walked into.** A one-shot value — an API key,
  a client secret, the set-password link — is always wrapped now rather than
  sitting in a box that scrolls sideways; the `wrap` prop is gone, because the
  argument for it assumed the value is selected by hand and it is copied with
  the button beside it. The applications table's consent column is headed
  **"Consent required"** and answers Yes or No in one affordance, and the
  create dialog asks **"Require consent"**, unticked by default; the wire and
  API field is still `skipConsent`, inverted once in a function with a test on
  it. And the discovery URLs on `/admin/system` open in a new tab — two of them,
  under a sub-path, are served by the reverse proxy above this application, so
  following one in place navigated out of it.
- **The reset page says whose account it is, and refuses a dead link up front**
  (**D65**). It used to render the form whatever the token was and report the
  problem only after a password had been typed twice — so an expired invitation
  looked exactly like a working one. It now reads the token first, without
  spending it, the way Better Auth's own link validator does, and names the
  address. An administrator's link opens the **invitation** variant: it says an
  administrator created the account, drops the promise about signing other
  devices out of an account nobody has signed in to, and points a dead link at
  the administrator rather than at self-service, which may be switched off. The
  one-time link dialog on `/admin/users` is labelled with the address as well.
- **The audit trail says what it means, and covers the admin API** (**D66**).
  An account an administrator created was recorded as `signup.created` with
  `by: "admin"` — the same action name as a self-service registration and as
  the first-run wizard, on a page whose filter lists action names. It is
  `user.created` now, and `signup.created` means self-service. Three admin
  endpoints — create user, set password, revoke sessions — wrote no row at all
  when called directly rather than through a button, which FR-ADMIN-6 does not
  allow of a supported interface; `impersonation.started` was written twice on
  the UI path; and `impersonation.stopped` was declared and never written,
  because nothing ever called the endpoint. The impersonation banner now has a
  **Stop impersonating** button, so it does.
- **The admin refusal is served with 403.** FR-ROLE-3 has always said so and
  nothing in the route tree ever set a status, so a signed-in user with no
  admin role got the "you do not have access" page with a **200** — recorded by
  every proxy, log and probe as a successful page view of the admin area. The
  page and its wording are unchanged: masking it as a 404 protects nothing,
  because `/admin` is a fixed, documented path, and costs a signed-in colleague
  a dead end.
- **A field's DOM id is generated rather than taken from its name.** `name` is
  unique in a form and not in a document, and moving the password change into a
  dialog gave `/account/security` three fields called `password` — so
  `<label for>` named the wrong control. Nothing about what is submitted
  changed.
- **`/admin/revoke-user-sessions` now revokes OAuth tokens however it is
  called** (**D67**). It is documented as signing a user out everywhere, and
  over the API it did not: Better Auth's admin plugin deletes session rows and
  knows nothing about tokens, and the half that revokes them had been written
  into the route handler behind the button — which no script, `curl` or admin
  API key goes through. So a direct call ended the browser session and left the
  refresh token minting access tokens, against FR-OIDC-12. It moved into the
  guard's `after` hook, which runs for every caller.

### Fixed from the field (2026-08-27)

- **A deployment no longer has to know its own public URL to let anyone sign
  in** (**D68**). `server.trustedOrigins` defaulted to `[server.baseUrl]`, so
  behind a reverse proxy whose address the IdP is given later, every sign-in
  met the `Origin` refusal of **D57** — permanently, not just on the
  `127.0.0.1`-instead-of-`localhost` first run. With the key unset the check
  now follows the request: the browser's `Origin` has to name the address the
  request arrived on (`X-Forwarded-Host`, else `Host`), which needs no
  configuration and is still a check a cross-site page cannot pass — it chooses
  neither side of it, and neither host header can be added to a cross-site
  request without a preflight this server does not answer. The header is
  compared and nothing more: SEC-1 is untouched and every absolute URL the IdP
  emits still comes from `server.baseUrl` alone. Setting the key pins the check
  to what it lists, as before; `*` is the documented way to turn it off.
- **The CSRF origin check was skipped in every test run this repository has
  ever made.** Better Auth defaults `disableOriginCheck` to `true` under
  `NODE_ENV=test`, and through its backward-compatibility arm that takes the
  Fetch-Metadata check with it — so SEC-3, which the suite claims to assert,
  was off wherever the suite could have noticed it breaking. The two new cases
  that assert a cross-site sign-in is refused both passed it until
  `advanced.disableOriginCheck: false` was set explicitly.

### Fixed after the fourth owner review (2026-08-27)

- **The first administrator holds the catalog's default role as well**
  (**D69**). The first-run wizard stored the first entry of
  `admin.adminRoles` and nothing else, while every other way an account comes
  into being — self-registration, the admin create form, the admin API's own
  fallback — also assigns the role marked `default: true`. So the one account
  a deployment is guaranteed to have was the one account an application gating
  on `user` excluded, which is how the owner got locked out of their own app.
  The two names are deduplicated, so a catalog whose admin role *is* the
  default stores `admin`, not `admin,admin`. Existing deployments are not
  migrated: the checkbox on `/admin/users/:id` is the fix for an account that
  already exists.
- **An admin form no longer blames a password nobody typed** (**D70**). A
  valid "Create a user" submission could answer *"That e-mail address and
  password combination is not correct"* — in a dialog with no password field.
  Better Auth spells the duplicate-address refusal differently on
  `/admin/create-user` than on `/sign-up/email`, only one spelling was mapped,
  and the SEC-7 catch-all — which exists so a public page cannot tell a wrong
  password from an unknown address — owned everything else. Behind `/admin/*`
  that collapse buys nothing (the administrator is looking at a list of every
  account) and costs the truth, so admin forms now map through
  `adminErrorCodeFor`: a duplicate address is named, and anything unrecognised
  is a failed request. The public pages are byte-for-byte unchanged.
- **Creating a user cannot 500 after the account exists** (**D70**). The
  set-password link was minted after the create returned, unguarded — so a
  failure there produced an error page, the natural retry was a duplicate, and
  the duplicate is what produced the sentence above. The tail is wrapped and an
  `ok` answer with no user id is refused rather than minting a link for `""`;
  both land back on the list saying the account was created but its link was
  not, and naming the two ways to give it a password.
- **A success message no longer outlives what it is about** (**D71**). "Roles
  updated.", "Signed out everywhere.", "Profile updated." — each arrived as
  `?notice=<code>` on the page the 303 landed on and was rendered as an inline
  banner, and nothing ever removed the parameter. So a reload re-announced the
  save, Back re-announced it, and a bookmarked URL announced last week's
  deletion as news. The eight admin and account pages now show the sentence as
  a toast and strip the parameter from the address bar as they do, without
  re-running a loader or spending a one-shot handle a sibling parameter has
  not read yet. Errors are unchanged and stay inline beside the form that
  produced them, where the restored draft is; the public auth pages keep their
  banners, because there the message *is* the page; and a one-time client
  secret or API key still gets its dialog. The component is the shadcn
  registry's Base UI `toast`, used verbatim — including its placement.
- **An application registered from `/admin/clients` can be edited, and its
  secret rotated** (**D72**). Before this the page offered create, disable and
  remove — so a typo in a name, a redirect URI that had moved, or a scope that
  should not have been granted meant removing the application and adding it
  again, which revokes every token and consent it held and hands its operator a
  secret they did not ask for. Every field except the client id is now
  editable, from a dialog on the list, prefilled from the row. The id stays
  fixed because the tokens, the consents and the audit trail all reference it.
  An edit is a full replace of what the dialog shows, and it preserves the
  three things the form does not own: the owning administrator (a null owner is
  what the next restart's orphan sweep disables), whether the client is
  disabled, and when it was created. A confidential application keeps the
  secret its operator already deployed, byte for byte; turning a single-page or
  native application into a web one issues a secret and shows it once; going
  the other way discards it — and only that change of kind revokes anything.
  Rotation is a per-row action: a new secret, shown once, with no grace window,
  and no revocation, because the client is still the same client — Disable and
  Remove are the ones for a compromise. File-managed applications gained
  neither control, for the reason they have none of the others. Both endpoints
  are on the admin API (`/idp/update-client`, `/idp/rotate-client-secret`) and
  both are audited.
- **A test that claimed to verify client authentication was verifying
  nothing.** It posted a junk authorization code to `/oauth2/token` and
  asserted the answer was not `invalid_client` — which it never could be, since
  the code is checked before the credential, so any secret at all produced
  `invalid_grant`. Found because the new rotation test asserts the *old* secret
  stops working and was told it had not. Both now use `/oauth2/introspect`,
  which authenticates the client before it answers, and assert both directions.
- **Destructive controls met the WCAG AA contrast floor they are gated on.**
  `variant="destructive"` is `bg-destructive/10 text-destructive`, which put
  `#e7000b` on `#fde5e7` — 3.98:1, under the 4.5:1 R-1 requires — so every page
  carrying a destructive dialog trigger failed the axe gate, and with it the
  whole end-to-end suite, including the second deployment shape that runs
  behind it. Found while running that suite; it predates this round's work.
  `--destructive` is darkened in both themes (light 4.62:1, dark 4.59:1 — the
  dark pairing had been sitting exactly on 4.50). A deliberate divergence from
  the shadcn preset, noted where the token is.
- **A toast is a `role="dialog"`.** Base UI gives it one, with
  `aria-modal="false"`, so its close and action buttons are reachable — which
  means a bare `getByRole("dialog")` matches two things once a confirmation is
  on screen, and Playwright's strict mode fails the test rather than the app.
  The end-to-end helpers select the modal by `data-slot="dialog-content"` now.

[Unreleased]: https://github.com/semantius/semantius-idp/commits/main
