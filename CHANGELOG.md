# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Decisions that changed a numbered requirement carry their `D` number from
[spec-v1.md](spec-v1.md) §12, where the reasoning is.

## [0.5.0] — 2026-08-28

### Changed

- **The config files are spelled `.jsonc` everywhere** (**D90**). **D60** made
  `.jsonc` the canonical extension and stopped there: the loader has resolved
  it first — falling back to `.json`, refusing a folder holding both — and
  `config.example/` has shipped it, for eleven months, while the spec still
  named `config.json`, `oauth_clients.json` and `roles.json` in nineteen
  places across G2, the glossary, FR-SOC-1, FR-ROLE-1/2, FR-ADMIN-2,
  FR-OIDC-2/4/6, DOC-1 and four decision rows — files a checkout does not
  contain. The prose comments through the server, the routes and the config
  schemas move with them. Two occurrences keep `.json` on purpose: D12's
  struck-through text, superseded by D52, and §14's spec-v0 traceability
  table, both of which quote an earlier document. **No requirement changes**:
  the fallback stays and a deployment written before D60 is still read.

### Fixed

- **No gate had ever booted a container from a `.jsonc` config folder**
  (**D90**). `apps/web/e2e/stack.ts` and `scripts/smoke-test.ts` each build a
  folder that stands in for an operator's, and both wrote the legacy `.json`,
  so D60's canonical path was covered by two unit tests at loader level and by
  nothing else in the repository — the TST-6 and TST-8 suites, the only gates
  that read a real deployment, exercised only the fallback. Both write
  `.jsonc` now. `makeConfigFolder`'s `json` default is deliberately unchanged
  and its docblock now says why: it is what keeps the fallback exercised by
  the whole unit suite rather than by one test, and the two harnesses cover
  opposite paths on purpose.

## [0.4.0] — 2026-08-28

### Changed

- **Requirement IDs no longer appear anywhere a user can read** (**D89**).
  `/admin/system` described e-mail as "Off — the server runs in degraded mode
  (FR-MAIL-2)" and offered a key rotation "so tokens already issued keep
  verifying (FR-OIDC-16)"; the degraded-mode warning on the same page ended the
  same way. Nothing outside this repository resolves those codes. The same
  habit is cleared from `idp --help` — where `idp cleanup` now says what it
  purges instead of naming a data-model rule — from the twenty-five
  configuration descriptions that feed `config-schema/*.schema.json` and the
  hover text an editor shows over a `config.jsonc`, and from
  `docs/configuration.md`. Every ID moves to a comment on the line it left, so
  the traceability is unchanged for anyone reading the source.
- **`/admin/database` is as tall as the window, and its three panes resize with
  it** (**D87**). The schema tree, the SQL editor and the result grid were each
  a fixed height inside a two-column grid, so none of them followed the
  browser: a wide window bought empty space beside two short cards, and a long
  result scrolled the whole document. The page is a full-height column now —
  `AdminShell` takes a `fill` prop for it — and every pane scrolls inside
  itself. Two `role="separator"` handles divide the tree from the console and
  the editor from the grid; both take arrow keys, and a double-click puts
  either back where it started. The editor opens at exactly nine rows and
  scrolls past them, sized in pixels rather than a percentage so that it is
  nine rows at every window height.
- **The schema tree no longer shows a row count** (**D88**). It was
  `pg_class.reltuples`, a planner statistic rather than a count: `-1` until
  something gathers statistics, and *inserting rows does not gather them*.
  Since the migrations build every table and its indexes before a row exists,
  every table stays at `-1` until autovacuum analyses it — which happens after
  fifty modifications. So the column reported **write volume, not size**:
  `rate_limit`, updated on nearly every request and holding two rows, was the
  only table with a figure beside it, while a `user` table, a `session` table
  and a 31-row `audit_log` showed nothing. A number that appears on the
  smallest table and on no other is worse than none. `GET /idp/database/schema`
  still returns the estimate, where it is documented as one.
- The page's description no longer wraps onto a second line. `AdminShell`'s
  `max-w-2xl` measure is right for a paragraph and wrong for a subtitle
  standing over a full-width console, so it takes a `wideDescription` prop
  (**D87**).
- **The `/admin` and `/account` shell is pinned to the viewport, and its
  content box is the scroll container** (**D87**). The registry's
  `SidebarProvider` is `min-h-svh` — a *minimum*, which leaves the box
  indefinite, so a child asking for a percentage of it got nothing. The
  sidebar and the header row now stay put on a page taller than the window,
  and that page scrolls beside them instead of the document.
- The client-bundle ceiling moves from 1185 kB to 1220 kB — the measured total
  plus the ~40 kB of headroom that figure has carried since it was written.
  The delta is `react-resizable-panels`, ~37 kB, taken from the shadcn
  registry rather than hand-rolled: the handles have to be real
  keyboard-operable separators on a page the R-1 accessibility scan visits
  (**D87**).

## [0.3.1] — 2026-08-28

**`v0.3.0` was tagged and never published.** Its release run built the image,
started it, migrated and signed a user in, then measured it at 374.8 MiB
against OPS-13's 350 MiB ceiling and refused to push — no image, no release.
The first entry below is the fix, and this version carries everything that
version was going to.

### Fixed

- **The image was 148 MB of icons nobody could reach** (**D86**). The first
  release containing the database console measured **374.8 MiB** on the runner
  against OPS-13's 350 MiB ceiling and refused to publish.
  `@hugeicons/core-free-icons` — one module per icon, several thousand of them
  — is inlined by Vite into the server chunks and read by nothing at runtime,
  so it joins `docker/Dockerfile`'s by-name prune list beside the compilers
  and test runners (**D76**). `lucide-react` deliberately stays: the server
  chunks import it. `/app` goes from 336 MB to 188 MB.

### Security

- **The nightly `pnpm audit` is green again** (**D85**). It was failing with
  sixteen advisories — 12 high, 3 moderate, 1 low — every one of them a
  *transitive dev* dependency: `brace-expansion` under two different
  `minimatch` majors, `js-yaml` under `eslint`, `shell-quote` and
  `launch-editor` under `@tanstack/devtools-vite`, `postcss` and `nanoid`
  under `vite`, `esbuild` under `drizzle-kit`'s deprecated `@esbuild-kit`
  loader. None of them ships in the image. They are closed with exact
  `pnpm.overrides`, scoped by version where two majors are in the tree and by
  parent where a global bump would be the bigger change — not by raising
  `--audit-level` and not by an ignore list. The install removed nine packages
  and the lockfile lost 261 lines: most of the advisories were duplicate
  copies of the same library. One `low` remains on purpose and is named in the
  decision: `drizzle-kit>tsx>esbuild`, whose fix is a major bump of the loader
  that reads `drizzle.config.ts`.
- `check-pinned-deps.ts` now checks `pnpm.overrides` as well as the four
  dependency fields — an override is a dependency decision, and one written as
  a range would drift exactly like a floating dependency (**D85**).

### Changed

- **`/admin/database` says it is read-only in its opening sentence**, and the
  paragraph that used to restate it below is gone (**D84**). A writable
  deployment keeps its second line, which is an instruction rather than a
  restatement.
- **`SchemaExplorer` and `SQLRunner` are forks now, not verbatim registry
  output** (**D84**). The registry component has no prop for a row action and
  the runner cannot be told to run, so both carry a header naming their
  divergences and every one is marked in place. A table row is a
  `div role="treeitem"` rather than a `button` carrying that role: a `tree`
  may own nothing but `treeitem` and `group`, so the action button cannot be
  the row's sibling without a critical axe finding, and a `button` inside a
  `button` is invalid HTML the parser un-nests into a hydration mismatch.
- **`/admin/*` and `/account/*` wear a sidebar shell** (**D82**), the one the
  sibling `semantius-app` has: a collapsible left sidebar carrying the
  navigation, the signed-in identity and its menu in the footer, full-width
  page content, and a sheet drawer below `md`. Collapsed it is an icon rail
  with tooltips, not a hidden navigation.
- **The chrome moved up into the two layout routes.** It was applied per page
  by `AdminShell` (seven pages) and `AccountShell` (five); it now lives in
  `routes/admin.tsx` and `routes/account.tsx` as one shared `SidebarLayout`,
  because a layout route's component survives every navigation inside its
  subtree and the sidebar's state and keyboard shortcut need that. The two
  shells are a page header apiece now, and the `max-w-6xl` / `max-w-4xl` caps
  are gone.
- The sidebar's brand block is **the area's name and nothing else** — no tile
  beside it, which is what both areas showed before. It is hidden on the icon
  rail rather than shrunk to an empty square (**D82**).
- **The way out of each area is in the sidebar's user menu**: the cross-area
  link — `/admin` for an administrator, `/account` from the admin area — and
  sign-out, which now goes through the `GET /logout` confirmation page that
  already existed. Amends FR-ACCT-1's "the header carries a link".
- **`/admin/*` has a `<main>` landmark**, which it never had: `SidebarInset`
  renders the only one, for both areas.
- The impersonation banner is rendered **once**, by the shared layout, which
  makes FR-ADMIN-5's "every page" true by construction and supersedes
  **D66**'s deliberate duplication across the two shells.

### Added

- **`/admin/database` chooses its schema, and every table row runs** (**D84**).
  `GET /idp/database/schema` now answers with every schema the console's
  connection may read — `has_schema_privilege(…, 'USAGE')`, catalog schemas
  and `information_schema` excluded — and takes `?schema=` to say which one to
  describe; an unknown name is `400 UNKNOWN_SCHEMA`, never a silent fall back
  to the deployment's own. The page draws the list as the schema tree's own
  header line, in place of a database name the runner beside it already
  carries and a `/ to search` hint that sat opposite a permanently visible
  search field. Every table row carries a run button that puts
  `select * from "schema"."table" limit 100` in the editor and executes it,
  schema-qualified because the search path is the deployment's schema and an
  unqualified name would read the wrong table the moment the selector moves.
  Neither widens what an administrator can reach: the query endpoint has
  always taken arbitrary SQL. The run request survives a click made before the
  editor pane has finished loading — both panes are lazy, and the tree is
  25 kB against the editor's 830.
- **`pnpm drizzle:studio`** — Drizzle Studio against this deployment's
  database, delegating to `pnpm --filter web run db:studio` the way
  `drizzle:reset` already does. It reads `apps/web/drizzle.config.ts`, so it
  inherits the two things that matter: `DATABASE_URL` from the repo-root `.env`
  and the `schemaFilter` of `IDP_SCHEMA_NAME ?? "idp"`, which keeps it out of
  every other schema in the database. `IDP_SCHEMA_NAME=idp_scratch
  pnpm drizzle:studio` aims it at a throwaway.
- **`/admin/database` — a schema explorer and a SQL console** over this
  deployment's own Postgres, behind the new tri-state `admin.database`
  (`disabled` | `read-only` | `read-write`, default **`disabled`**) —
  **FR-ADMIN-7**, **D83**. The left column is a searchable tree of tables,
  columns, indexes and foreign keys; the right is a SQL editor with syntax
  highlighting, an inline error marker and a results grid.
- `GET /idp/database/schema` and `POST /idp/database/query`, admin-gated like
  every other endpoint and reachable with an admin API key (FR-ADMIN-6).
  **With the flag at `disabled` they are not registered**, so they answer 404
  rather than 403 — the feature is absent, not switched off, which is what the
  owner asked for and the shape `apiKeys.enabled: false` already had.
- `SchemaExplorer` and `SQLRunner` in `packages/ui`, vendored verbatim from
  ui.neon.com's shadcn registry, plus `styles/neon-supplement.css` — the two
  custom properties and the one utility class they name. The registry's own
  `tokens.css` is **not** imported: it redefines the whole palette, including
  the hand-measured `--destructive` and `--sidebar-*` divergences (**D83**).
- `database.queried` in the audit trail (SEC-6): one row per execution, success
  or not, carrying the first 500 characters of the statement, the mode and the
  outcome.
- `tests/unit/database-introspect.test.ts`, `tests/integration/database-admin.test.ts`
  and `e2e/database.spec.ts`; `/admin/database` joins the axe scan.
- R-1 corrections for the vendored components, in `neon-supplement.css` and
  scoped to their own `data-slot` roots: the low-alpha `--muted-foreground`
  and `--destructive` inks (1.97:1 to 3.68:1) go to full opacity, and
  CodeMirror's own `#888` placeholder (3.54:1) to `--muted-foreground`. All
  measured beside the rule, none of it a patch to registry output (**D83**).
- `packages/ui/src/components/{sidebar,sheet,tooltip,skeleton}.tsx` and
  `packages/ui/src/hooks/use-mobile.ts`, from the shadcn registry, used
  verbatim. No new dependency.
- `idp_sidebar_state`, a cookie **scoped to the mount path** (OPS-10) and read
  on the server (`server/http/sidebar-cookie.ts`), so the collapse state is
  right on the first paint instead of snapping shut after hydration. The
  registry component's own root-path `sidebar_state` write is unread and
  accepted rather than patched out of generated output.
- `common.toggleSidebar` in the message catalog, which names the trigger
  (FR-I18N-1); `e2e/layout.spec.ts` and a unit test for the cookie reader.

### Fixed

- **The mobile drawer closes on a navigation.** It is a modal sheet and a
  client-side navigation does not unmount it, so below `md` a tapped nav entry
  changed the page underneath a drawer that was still covering it and holding
  the focus trap. Closed on the route, not on each link (**D82**).
- The identity tiles in the sidebar use the **accent** surface rather than
  `--sidebar-primary`, which the reference shell uses for a white icon and
  which measures 3.07:1 / 2.12:1 behind *text* — under R-1's 4.5:1 floor. The
  measurements are recorded beside the class, because re-applying a preset
  resets the tokens (**D82**).

## [0.2.0] — 2026-08-27

Owner review round 4, and the first release cut after one. Three field
reports from the running deployment and one requirement that could not be
met by the accounts it applied to.

Published as `ghcr.io/<owner>/semantius-idp:0.2.0` (also `0.2`, `0`, `latest`
and `sha-<commit>`) for `linux/amd64` and `linux/arm64`, by
[`.github/workflows/release.yml`](.github/workflows/release.yml) (**D73**).

### Removed

- **The re-authentication gate on sensitive actions** (**D81**). FR-AUTH-5
  required a session younger than `session.freshAgeMinutes` (15) for every
  password, e-mail, second-factor, API-key and admin write, or a
  re-authentication. It could not be satisfied by an account that
  authenticates through Google, GitHub or Entra — there is no password to
  re-present — and the provider button it fell back to drops the `returnTo`
  and the draft, then satisfies the gate with a silent SSO that proves
  nothing. Removed, with `session.freshAgeMinutes`, the `reauth` /
  `reauth_draft` notices and `server/http/fresh-session.ts`. Every mutating
  handler still requires a session, now read past the cookie cache
  (`server/http/require-session.ts`), so a revocation or a suspension bites on
  the next write rather than up to five minutes later. Better Auth's own
  `freshAge` is set to `0` so it does not reimpose the rule on `/delete-user`
  and the e-mail change.

### Fixed

- **A success confirmation now names the account it is about** (**D78**). "The
  account has been deleted." was the same sentence for every account, and it
  lands on the list, where the row that could answer *which one* is exactly
  what has gone. The address appears on a second line of the toast. Across the
  two redirects that need it — a deletion and a creation — it travels as a
  one-shot handle rather than in the query string, which the request log keeps.
- **A toast can no longer be pinned to the screen by an unfocused window**
  (**D78**). Base UI freezes every auto-dismiss timer while the window is
  blurred and thaws it only on the way back, so a confirmation left behind a
  switched-away window stayed there for the length of the absence — the
  outliving-its-truth D71 set out to end. A wall-clock backstop closes it two
  seconds past its nominal lifetime; hovering it or tabbing into it still
  pauses the dismissal, which is the pause WCAG 2.2.1 asks for.
- **Registering an application now says why it has no client secret**
  (**D78**). The form's default type is a single-page app, which is a public
  client: no secret is generated, no *Rotate secret* control appears on its
  row, and nothing said the two facts were one fact. The type field states the
  consequence in both dialogs, the confirmation distinguishes a public client
  from an update that kept its secret, and the table reads "Public — no client
  secret".

### Changed

- **`/admin/clients`'s per-row actions are a `⋯` menu** (**D80**). Disable,
  Edit, Rotate secret and Remove were stacked under the Enabled/Disabled badge
  in the Status column, so a table of one-line columns had rows four buttons
  tall. They move to a column of their own; Status is status again. The menu
  is named for the application it acts on, and a file-managed row has no menu
  rather than an empty one.
- **The way to give a public application a secret is discoverable** (**D78**).
  Changing its type to Web in the edit dialog issues one and shows it once —
  a path **D72** built and the interface never mentioned.

## [0.1.0] — 2026-08-27

The first published image. It is the whole of v1's functionality, released
ahead of the v1.0.0 sign-off gate in [docs/release.md](docs/release.md) —
the two checks that cannot be automated, the manual social walk-through and one
real token against a real Neon project, are what 1.0.0 still waits on.

Published as `ghcr.io/<owner>/semantius-idp:0.1.0` (also `0.1`, `0`, `latest`
and `sha-<commit>`) for `linux/amd64` and `linux/arm64`, by
[`.github/workflows/release.yml`](.github/workflows/release.yml) (**D73**).

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
- **The integration suite takes three minutes instead of fifty-four.** Almost
  none of that hour was the application. The suite defaulted to the
  deployment's own hosted database, which is **~102 ms away per round trip**,
  and every test context it builds drops a schema and applies 77 migration
  statements one at a time — about eight seconds of pure latency each, before a
  single assertion, times more than a hundred contexts, serialised.
  `test:integration` and `test:coverage` now start and reuse a local Postgres
  container (`idp-test-db`, fsync off) unless `IDP_TEST_DATABASE_URL` says
  otherwise, which is how CI keeps using the service container it already had.
  Identical 840 tests, identical coverage. It is also the safer default: a test
  schema on the deployment's database is one typo away from the persistent one.
- **A test that built its own connection forced TLS unless the URL said
  `localhost`.** The same `127.0.0.1` trap as **D57** and **D68**, and against
  a local Postgres it surfaced as "Client network socket disconnected before
  secure TLS connection was established" — which reads like a network fault and
  is a configuration mistake. `testDatabaseSsl()` applies the precedence the
  application itself uses: an explicit `sslmode` wins, then loopback in any
  spelling means off.

### Release plumbing (2026-08-27)

- **A tag now publishes something.** `ci.yml` carried the whole release path —
  QEMU, the GHCR login, the amd64 + arm64 push, the `X.Y.Z`/`X.Y`/`X`/`latest`
  tag set OPS-1 specifies — behind `startsWith(github.ref, 'refs/tags/v')`, in
  a workflow that triggers on `push: branches: [main]`. A tag does not match a
  branch filter, so **none of it had ever run**, while
  [docs/release.md](docs/release.md) described it as the thing tagging does.
  Publishing moved to its own [`release.yml`](.github/workflows/release.yml)
  on its own `push: tags:` trigger (**D73**): it builds amd64, runs the TST-8
  container smoke test, the Trivy scan and the SBOM against that image, then
  builds and pushes both architectures from the same layer cache and opens a
  GitHub release whose notes are this file's section for the version. A
  `workflow_dispatch` **rehearses** — both architectures, no push — so
  "does arm64 build?" can be answered before a tag exists to answer it badly.
  `ci.yml` keeps building and smoking an amd64 image on every pull request and
  merge, and its dead publish steps are gone.
- **The arm64 image had never been built, and did not build.** OPS-1 has said
  "amd64 + arm64" since it was written, and the first
  `--platform=linux/amd64,linux/arm64` run anybody ever performed failed at
  `bun build` with `qemu-x86_64: Could not open
  '/lib64/ld-linux-x86-64.so.2'` — which reads like a missing library and is
  an amd64 binary being executed inside an arm64 root filesystem. The cause is
  the borrowed Bun: `docker/Dockerfile`'s `build` stage is pinned to
  `--platform=$BUILDPLATFORM` and *executes* the binary it copies out of the
  `bun` stage, but the `bun` stage was **not** pinned — so BuildKit
  instantiates it once per *target* platform while `build` exists once in
  total, and the single build stage is handed whichever of the two the other
  pass resolved. `FROM --platform=$BUILDPLATFORM oven/bun:…` makes the
  borrowed binary match the rootfs that runs it, on any build host. `runtime`
  stays unpinned, because that stage is the artefact and is the one thing here
  that must be per-architecture.
- **The tag and `package.json` have to agree.** The image stamps
  `IDP_VERSION` from the tag and `/healthz`, `idp version` and the admin
  system page all report it, so a repository claiming 0.0.1 while the artefact
  claims 0.1.0 is one whose running version cannot be traced back to a tree.
  The release workflow's first job refuses the tag otherwise, in thirty
  seconds rather than at minute fifteen. The workspace is at **0.1.0**
  accordingly, and `version.ts`'s development fallback with it.
- **`docker/release.sh vX.Y.Z` cuts a release**, adopted from `semantius-app`,
  whose copy has cut three. It refuses a detached HEAD, a dirty tree, a branch
  out of sync with its upstream, a tag that already exists locally or on the
  remote, and a version that is not newer than the latest tag; prints what will
  be published — image tags, whether the changelog has a section for the
  version, what CI last said about the commit — and asks before doing anything.
  Then it bumps all three files that carry a version, commits, tags (signed
  where a key is configured, annotated where not) and pushes. Two deliberate
  differences from the sibling: a **pre-release is allowed** here, because this
  workflow derives `latest` from the version rather than tagging it
  unconditionally; and a **failed `-s` degrades to `-a`** rather than aborting
  after the bump commit has already been pushed, which is the one state that
  needs a human to unpick.
- **Either database connection string alone is now a valid deployment**
  (**D74**). `database.url` was required and `database.directUrl` optional
  beside it, which had it backwards. The **direct** endpoint is the one that
  must always work — startup, migrations, the CLI and the cleanup job take
  session advisory locks, and those do not hold through a transaction-mode
  pooler (**D27**) — while the pooled endpoint is an optimisation a given
  Postgres may not offer at all. So an operator holding only the direct
  endpoint had to file it under the name that describes the pooled one, and
  one who set only `DATABASE_URL_ADMIN` was refused outright for a
  configuration that works perfectly. Both keys are optional now, with at
  least one required; each falls back to the other, resolved once in
  `derive.ts` as `databaseUrl` and `databaseDirectUrl`, so a single-endpoint
  deployment gets the same string for both — which is correct, because a plain
  Postgres endpoint is already direct. The pooled-without-direct warning is
  unchanged; it is still the one combination that is genuinely wrong.
  `idp config validate` prints the direct endpoint too, but only when it
  differs.
- **`aquasecurity/trivy-action@0.28.0` was wrong twice over** (**D75**). That
  repository tags `v0.28.0`, not `0.28.0` — and `v0.28.0` then calls
  `aquasecurity/setup-trivy@v0.2.1`, **a tag that has since been deleted**
  (`setup-trivy` now publishes only `v0.2.6`, `v0.3.0`, `v0.3.1`). A composite
  action's own dependencies resolve at the same moment as yours and fail the
  same way, at `Set up job`, before any step runs and naming none. Pinned to
  `v0.36.0`, which references `setup-trivy` by **commit SHA** — the shape that
  cannot be retagged out from under a build. Nothing local catches this class
  of fault; the reference had sat in `ci.yml` from the start, unresolved,
  because no workflow in this repository had ever run.
- **The container smoke test exited 0 while printing FAIL** (**D75**). Its
  summary and `process.exit` sat at the end of `main`, after the `try`/`finally`
  - and three failure paths `return` early, so every one of them skipped both.
  A missing image, or a stack that never came up, was reported to CI as a pass.
  TST-8 is the only gate that tests the artefact a tag publishes, and it could
  not fail. Both now live at the call site, where a `return` cannot reach them.
- **The smoke test could test the wrong image entirely** (**D75**).
  `docker-compose.yml`'s `idp` service carries both `image:` and `build:`, so
  `compose up` silently builds from source when the tag is absent - right for
  `idp-create.sh`, wrong for a gate whose whole purpose is to exercise the
  artefact CI is about to publish. A mistyped `IDP_IMAGE` would have it pass
  while proving nothing. It now refuses to start unless the image is already in
  the daemon. Found by pointing it at `nonexistent-image:v0`, which built one.
- **A failed check is a GitHub Actions annotation** (**D75**). A `run:` step
  that exits non-zero produces no annotation, and job logs are 403 without
  admin rights - so a CI failure here was unreadable while the cause sat in
  stdout nobody could fetch. Every failed check, and the `docker compose logs`
  tail the script already dumped, now go out as `::error::` lines, which land
  in `check-runs/{job_id}/annotations` - the channel that is readable.
- **The image shipped 91 MB of build tooling, and was 28% over its own
  ceiling** (**D76**). `pnpm deploy --legacy --prod` ignores `--prod` - pnpm 10
  refuses a non-injected workspace deploy without `--legacy`, and the legacy
  path copies the whole virtual store - so `drizzle-kit`, `prettier`, `vitest`,
  three `esbuild` binaries, `@rolldown/binding`, `lightningcss` and
  `caniuse-lite` were all inside the runtime image. They are removed by name
  now, with the step failing loudly if the removal frees nothing, so a rename
  upstream breaks the build instead of quietly restoring the weight. The image
  drops from 385.8 MiB to about 295 MiB on amd64, and OPS-13's ceiling moves
  from 300 MB to 350 MB so the target keeps a margin.
- **Nothing local could ever have caught it.** OPS-13's size check reads
  `docker image inspect --format {{.Size}}`, and Docker Desktop's containerd
  image store answers with the **compressed** size: 117.9 MiB for the image a
  GitHub runner measures at 385.8 MiB. Both numbers are honest and only the
  second one is the artefact. The budget now says so where somebody will read
  it before trusting a local pass.
- **Playwright reports failures where they can be read** (**D75**). The suite
  uploads an HTML report, and downloading a workflow artifact needs a token
  just as job logs need admin rights - so a browser failure reached an outside
  reader as `Process completed with exit code 1` and nothing else. The `github`
  reporter is added in CI, which writes `::error` lines into
  `check-runs/{job_id}/annotations`. Same wall the container smoke test hit,
  same way through it.
- **The e2e mail directory was unwritable by the container on Linux**
  (**D77**). Twenty tests failed on the first CI run the suite ever had, all
  with `Captured: nothing`, and every anonymous test passed - the split was
  exactly "needs a verified user". The capture transport writes JSON files into
  a directory bind-mounted to `/mail`; the image runs as uid 1000 and a GitHub
  runner as uid 1001, and a bind mount carries host ownership through. Docker
  Desktop does not enforce host uids, so it cannot reproduce - 78 tests pass
  locally against the exact image that failed on the runner. The directory is
  now `chmod 0777` (a `mkdtemp` directory for one run), rather than pinning the
  container's uid, which would change the artefact under test.
- **Bun's version is pinned in five files and nothing compared them.**
  `.bun-version`, `package.json`'s `engines.bun`, the Dockerfile's
  `ARG BUN_VERSION`, and now both workflows. Bun is not a build tool in this
  repository — it is **the runtime**: the final stage is
  `oven/bun:<version>-slim` with Bun as PID 1, and on arm64 that is a
  different binary from the one CI runs. Drift would be quiet and specific —
  the smoke test passing on one Bun while the image ships another, surfacing
  only as a runtime failure in somebody's deployment.
  `scripts/check-bun-version.ts` compares all five against `.bun-version` and
  is a CI gate. A pin whose line has moved reports as missing rather than
  passing, because a checker that silently stops checking is worse than none.
- **The Dockerfile claimed to pin digests and never has.** "The digest pins
  the image … the digest is what Docker actually resolves" sat above two
  `ARG`s and zero `sha256:` references. The images are pinned to exact version
  *tags*, which is a weaker guarantee, and the comment now says so.
- **The image's `org.opencontainers.image.source` label pointed at the wrong
  repository** — `adenin/semantius-idp`, where the remote and this file's own
  links both say `semantius/semantius-idp`. The label is how a pulled image
  says where it came from, so it was sending anyone who inspected it to a
  repository that is not this one.

[Unreleased]: https://github.com/semantius/semantius-idp/compare/v0.5.0...main
[0.5.0]: https://github.com/semantius/semantius-idp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/semantius/semantius-idp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/semantius/semantius-idp/compare/v0.2.0...v0.3.1
[0.2.0]: https://github.com/semantius/semantius-idp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/semantius/semantius-idp/releases/tag/v0.1.0
