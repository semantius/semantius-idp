# semantius-idp — where the plan stands

**As of:** 2026-08-25 · **Branch:** `feat/idp-v1` · **Base:** `main` · **Head:** `004ac26`
**Plan:** `~/.claude/plans/finish-idp-v1-s3-m6-m14.md`
**Spec:** [spec-v1.md](spec-v1.md) — amended through **D38**

**S3 and M6–M12 are done. M13 is started** — the Playwright harness runs
against the built image in both deployment shapes, and the gate that would have
caught the unstyled sign-in page now exists. **M14 (docs, release) is
untouched.** Every gate green: lint, typecheck, unit (464), integration
(210 across twenty-three files), coverage thresholds including the 85 %
per-module gates, schema-drift,
config-schema staleness, dependency pinning, the client-bundle gate — and, new
in M12, the **TST-8 container smoke test**, which drives the built image from
`compose up` through a scripted forced password change to a verified JWT and a
clean SIGTERM.

**If you are wondering why the sign-in page looked unstyled** — it was, for
every developer, on every page, since spike S3, and no gate in this repository
could see it. That story is the first section below.

---

## Review results

_Empty — nothing outstanding. The next round's findings go here, and are
treated as pre-work before any further milestone starts._

---

## The sign-in page had no CSS, and nothing could tell

**Reported by the owner as "the login page is unbranded".** It was, and not
only the login page: under `vite dev`, *every* page had been arriving with no
stylesheet, no client entry and no hot reload. What made it look like a
branding bug rather than a total one is that the server-rendered markup was
perfect — the site name, the layout, every Tailwind class name, all present.
Only the paint was missing.

**Cause.** `vite.config.ts` set `base: "./"`, which spike S3 chose so that one
build relocates to any mount path. Vite 7 and earlier coerced a relative base
back to `/` for the dev server; Vite 8.0.16 does not, and prefixes every
transform URL with `/./` instead. A real path survives that — `/./src/router.tsx`
still resolves against the root, which is why the app itself kept working — but
Vite's own URLs are recognised by their `/@` prefix and do not:

```
vite:resolve  /./@fs/C:/…/packages/ui/src/styles/globals.css  ->  null
```

`/@fs/…`, `/@id/…` and `/@vite/client` all resolved to null, fell through to
the application router, and came back as its 404 page — behind a stylesheet
link that looked perfectly well-formed. **Fixed** by making the relative base a
*build* concern only: `base: command === "build" ? "./" : "/"`. The built output
is unaffected — `dist/server` still emits `"./assets/globals-<hash>.css"`, which
is exactly what `assetUrl()` rewrites onto the mount path — so S3's sub-path
property is untouched, and that was checked by building rather than by
reasoning.

**Why no gate caught it, which is the more important half.** Every gate here
reads HTML or JSON. `test:e2e` has been declared-but-inert since M1, there is
no `playwright.config.ts`, and not one test had ever asked a dev server for an
asset. The markup assertions all passed because the markup was right.
`src/tests/integration/dev-server.test.ts` is the missing gate: it starts a real
Vite dev server and fetches `/@vite/client` and the stylesheet, asserting the
second is `text/css` containing compiled Tailwind. Putting the old config back
makes all three of its cases fail, which was checked rather than assumed.

That closes the specific hole. **The general one is still open:** nothing in
this repository renders a page in a browser and looks at it. That is M13's job
(TST-6 plus axe), and this is the second time a purely visual defect has
shipped past a green board — R-1 was the first.

---

## M12 — the container milestone, and the seven things it found

**M12 is complete.** The image builds, `docker compose up` brings up a working
IdP, both Caddyfiles validate, all seven OPS-6 commands run inside the
container, and TST-8's smoke test drives the whole thing end to end.

### What landed

- **OPS-4 draining** (`server/http/lifecycle.ts`, `src/serve.ts`). Shutdown is
  split into the two things it actually is: *stop being chosen* — `/readyz`
  answers 503 the moment SIGTERM lands — and *stop holding*, where the pool
  closes only once the in-flight requests have finished. Releasing at signal
  time is the mistake the split exists to prevent: it turns a rolling deploy
  into a burst of 500s. A second signal exits at once; `/healthz` keeps
  answering 200, because a container draining on purpose is not one to restart.
  `shutdownRuntime()` closes a runtime **only if one was built** — the obvious
  `getRuntime().then((r) => r.shutdown())` would run the whole OPS-2 sequence,
  migrations included, on the way out of the door.
- **All seven OPS-6 commands.** `config validate` (no database — an operator
  whose config is wrong may not be able to reach one), `migrate`,
  `reconcile-clients`, `reset-admin`, `rotate-keys`, `cleanup`, `version`.
  Verified inside the image: `docker run <image> idp config validate` prints
  the issuer, the masked connection string, the counts and the warnings.
- **The retention job** (`server/cleanup.ts`, OPS-8/DM-5). Nine tables, each
  purged on the question *is this row still capable of doing anything* rather
  than on age. Two deserve naming: token rows wait **30 days after death**
  because a revoked token still in the table is the answer to "was this revoked
  or did it never exist", which is the first question anyone asks after a leak;
  and `jwks` is purged at expiry **plus the grace period**, never at expiry,
  because a retired key still verifies tokens signed before it stepped down.
  The interval job schedules the next run when the last one *finishes*, so a
  slow sweep cannot stack.
- **`routes/branding.$.ts`** (CFG-1) — the operator's logo and favicon out of
  the read-only config mount, written as a series of refusals rather than
  transformations, because it is the one place a URL becomes a path on disk.
- **The image, compose, both Caddyfiles, the smoke test and the CI job.**
  118.9 MiB against OPS-13's 300 MB ceiling.

### The seven things running it found

The first four came out of the smoke test, in the order it runs, and none of
them is visible to any unit or integration test. That is the argument for TST-8
in one sentence: every one would otherwise have been found by the first person
to follow the README.

1. **`env_file: .env` sent the operator's own database into the container.**
   The worst of the set. `DIRECT_DATABASE_URL` is a bootstrap fallback for
   `database.directUrl` — the connection *every advisory-locked step* uses:
   migrations, the signing key, the client reconcile, the bootstrap admin. A
   developer's `.env` has it pointing at their real database, and compose
   passed it straight through, so the container **served from the compose
   Postgres while migrating somebody else's**. It happened here, on the first
   run that got far enough: the direct handle reached a production Neon
   endpoint. It was refused — the derived SSL mode did not match what Neon
   requires — and the persistent `idp` schema was checked afterwards and is
   untouched: one user, migrations dated the previous day, no audit row from
   the run. `DIRECT_DATABASE_URL` and `IDP_SCHEMA_NAME` are now pinned in
   `environment:`, which wins over `env_file`.
2. **`IDP_CONFIG_DIR` leaked the same way**, and is the same fix. `.env` says
   `./config` — a *host* path — so the container looked for its configuration
   at a directory that does not exist inside it and restart-looped with
   "Required file not found at C:/…/config/config.json".
3. **`serve.ts` was copied into the image as TypeScript source.** It imports
   across `src/`, and the final stage has no `src/`, so every start died with
   `Cannot find module './server/config/loader'` — while the container was
   reported only as "unhealthy". Both entrypoints are bundled now.
4. **The reference deployment could not have worked at all.** `database.ssl`
   defaulted to `require` for any host that is not literally localhost —
   correct for a hosted database, wrong for compose, where the host is
   `postgres` on a private network. Every operator following the quick start
   would have hit `Client network socket disconnected before secure TLS
   connection was established`, which names nothing they could act on, against
   a URL that had said `sslmode=disable` all along. An explicit `sslmode` is
   now honoured ahead of the heuristic. `prefer` and `allow` deliberately are
   not: they mean "try, then downgrade", and reading either as "disable" would
   silently drop TLS on a hosted database because a URL was copied from
   somewhere.
5. **`/readyz` knew why it was failing and said nothing.** Its `catch` was
   bare, so a stack whose start-up was failing reported `config: false` for as
   long as you cared to watch, with no line anywhere naming the cause — which
   is how finding (1) took as long as it did. It now logs the reason once per
   distinct message: the response stays non-revealing (it is unauthenticated),
   the log does not.
6. **The `jwks` purge bound a `Date` into a raw SQL template** and postgres.js
   refused it — the identical mistake that cost M10 a 500 on the whole
   dashboard. Subtracting the grace period from `now` instead of adding it to
   the column is the same inequality with no raw SQL at all.
7. **`site.logo` had two spellings and one of them 404s.** The schema describes
   a path *under* `branding/`; the shipped example has always shown
   `branding/logo.svg`. Both name the same file, so both now resolve to
   `/branding/logo.svg` rather than one of them producing
   `/branding/branding/logo.svg`.

### What is deliberately not here

`docker-compose.dev.yml` (the plan calls it optional) and the arm64 leg of the
build on pull requests — arm64 is emulated in CI and roughly triples the build
for an artefact nobody merges, so tags build both and PRs build amd64.

**The SIGTERM path is now genuinely exercised** — the smoke test stops the
container and asserts the exit code is 0 rather than 137. On Windows it still
cannot be: `uv_kill` maps SIGTERM to `TerminateProcess`, so a developer machine
can never run it, which is why `tests/unit/lifecycle.test.ts` covers the
ordering with fakes as well.

Smoke test, against the built image: ready in **0.38 s** (budget 5 s), idle RSS
**202.7 MiB** (budget 256), image **118.9 MiB** (budget 300), clean exit on
SIGTERM. All sixteen checks green.

### `idp reset-admin`, and the two things it refuses

It resets the named administrator's credential password back to
`admin.bootstrap.password`, re-arms `mustChangePassword`, makes the account
reachable again (active, unbanned, verified) and deletes every session — all
under the `bootstrapAdmin` advisory lock, so it cannot race a booting
container. The password is never printed, logged or written to the audit trail.

Two refusals, both deliberate and both tested:

1. **It does not promote.** An address that exists and holds no admin role is
   refused. A local command that promoted whatever it was pointed at would be a
   one-line privilege escalation for anyone who can read the config folder.
2. **It does not create an address you typed.** With no argument it will create
   `admin.bootstrap.email` — that is the bootstrap contract, and running it
   against a fresh database is an intended path. But
   `idp reset-admin adnim@example.com` fails rather than quietly provisioning a
   second administrator. Found by running it: the first version created one.

Proof is `src/tests/integration/reset-admin.test.ts`, which lives through the
whole incident — create, sign in, change the password to something only the
operator knows, lose it, reset, sign in again with the `.env` value.

### The `azp` discriminator, deferred from M10 and now fixed

`sessionTokenPayload` decided "did this come from an API key?" with
`typeof session.session.token !== "string"`. In 1.7.1 the api-key plugin puts
the **key string** there, so the test was always false: every key-issued JWT
claimed `azp: "idp"`, and `apiKeys.tokenClientId` was configuration that did
nothing. It stayed invisible for two reasons, not one — `tokens.test.ts`
asserted the behaviour the bug produced, *and* the test config left
`tokenClientId` at its `"idp"` default, so that assertion would have passed
whichever way the discriminator went.

The answer now comes from `isApiKeySession`, reading a marker
`options/api-key-gate.ts` stamps on the session it watched the plugin build —
the one place in the process that knows. The marker is a `Symbol.for` key for
two reasons that both matter: `JSON.stringify` ignores it, so `/get-session`
answers exactly what it answered before; and no request body, database row or
parsed JSON can ever produce a symbol, so a caller cannot claim to be an API
key by sending a field. `azp` is authorization-relevant, so that second
property is pinned by its own unit test.

`tokens.test.ts` now sets `tokenClientId: "api-key-client"` and asserts both
halves — the key exchange carries it, and the same endpoint reached with a
session cookie carries `"idp"`.

---

## M13 — the browser gate exists now

**The hole this closes is the one this session opened with.** Nothing in the
repository had ever rendered a page and looked at it, which is how a sign-in
page with no stylesheet survived four milestones of a green board.

`apps/web/playwright.config.ts` drives the **built image** — not `vite dev` —
in two projects, because a sub-path deployment is a different application as
far as every URL is concerned:

- **host-root** — the image on `:3410`;
- **subpath** — the same image behind Caddy at `/idp` on `:3411`, using
  `Caddyfile.subpath` through `docker-compose.e2e.yml`.

Both stacks are brought up by `e2e/stack.ts` with generated config folders and
their own Postgres volumes, so a run cannot touch the operator's stack or the
persistent `idp` schema (P0'.2).

`e2e/rendering.spec.ts` is the gate itself. It asserts **computed style and
layout**, never screenshots: how many CSS rules the browser actually parsed
(a `<link>` that 404s still appears in `document.styleSheets` with zero rules,
so counting sheets proves nothing), that the shell is a flex column, that the
heading is not the browser's default 32 px, that the input has a radius, that
every asset URL sits under this deployment's own base URL, and — by tabbing to
the reveal control and pressing Space — that the page hydrated at all. A pixel
baseline would fail on font rendering, get updated without being read, and stop
meaning anything by the third time.

**The sub-path deployment has now been driven end to end for the first time**
and works: `/idp/login` serves with `/idp/assets/…` URLs, and the origin-root
RFC 8414 route answers at `/.well-known/oauth-authorization-server/idp`.

### D30, and two things the harness itself got wrong

**D30 — the capture transport writes files.** `IDP_EMAIL_TRANSPORT=capture`
(environment-only, CFG-3's env-only class) swaps Resend for a transport that
writes each message to `/mail` as JSON, which the e2e overlay bind-mounts out
of the container so a spec can read a verification or reset link. Files rather
than an HTTP endpoint, because an endpoint that returns captured mail is an
endpoint that returns password-reset links and it would exist in the shipped
image. It is honoured **only when e-mail would otherwise work**: capturing in
degraded mode would make FR-MAIL-2's "nothing is sent" untestable.

Two harness defects, both found by running it:

1. **The sub-path project was testing the wrong URL.** `page.goto("/login")`
   resolves the way `new URL` does — an absolute path replaces the base's whole
   path — so against `http://127.0.0.1:3411/idp` it requested the *origin root*,
   which under a sub-path deployment belongs to somebody else's application.
   The failure read "no Password field", which is a confusing way to learn the
   test was wrong rather than the deployment. An `app.goto()` fixture now
   applies the mount path, and a leading slash cannot get it wrong again.
2. **Clicking the reveal checkbox is not how anyone uses it.** The checkbox is
   `sr-only`; the eye icon painted over it intercepts the click, exactly as it
   would for a person. Driving it from the keyboard asserts the two things R-1
   asked for at once — reachable in the natural tab order, and the accessible
   name changes with the state.

### What is left of M13

The flow specs (sign-up, verification and reset through captured mail, 2FA
enrolment and challenge, consent, end-session, the account area, the admin
surface), axe with zero serious/critical per page, the sample relying party,
and the CI e2e job.

---

## S3–M8: what those sessions did, and what they broke open

Four milestones landed in plan order: **S3** (one build, two mount points),
**M6** (2FA + social enforcement), **M7** (the account area, API keys, the
freshness gate) and **M8a/b/c** (client reconciliation, tokens and claims, the
issuer-root protocol surface). Each is described in its own commit message.

**Eleven defects were found by running things rather than reading them**, which
is the same lesson Phase 0 recorded:

|          |                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S3-1** | Better Auth was unreachable under a sub-path — 1.7.1 appends `basePath` to `baseURL` only when `baseURL` has no path, so the issuer mounted everything at `/idp/*` and nobody could sign in |
| **S3-2** | Nothing emitted `<link rel="icon">`, so browsers probed `/favicon.ico` at the _origin_ root — someone else's application under a sub-path                                                   |
| **M6-1** | The audit trail called a 2FA challenge a completed sign-in                                                                                                                                  |
| **M6-2** | `?forced=1` was never true: the router parses query values with `JSON.parse`, so the forced-password-change page had been rendering the ordinary screen                                     |
| **M6-3** | Declaring `validateUserInfo` made Better Auth refuse every user creation without an endpoint context — the bootstrap admin died at start-up                                                 |
| **M6-4** | `syncProfile` mapped to nothing, so the documented default of refreshing a social profile never happened                                                                                    |
| **M7-1** | An API key kept working after its owner was banned or un-approved                                                                                                                           |
| **M7-2** | The freshness gate read the cookie cache, so a twenty-minute-old session could mint an API key                                                                                              |
| **M7-3** | `/account/security` put 200 KB of Drizzle and the whole schema in the browser bundle                                                                                                        |
| **M8-1** | Every session JWT was born expired — `jwt.expirationTime` took a number as an absolute `exp`, so `GET /api/auth/token` returned tokens that expired in 1970                                 |
| **M8-2** | `/.well-known/security.txt` served "Welcome to Bun!", and a GET to `/oauth2/token` served the sign-in page with a 200                                                                       |

Two spike conclusions turned out to be wrong and are recorded as decisions:

- **D32** — S1/S5 planned to normalise `aud` in the `jwt.sign` seam. That seam
  does not exist for a self-hosted key set: the `jwt` plugin refuses to
  construct with `jwt.sign` unless `jwks.remoteUrl` moves the keys off the
  deployment. `aud` keeps the implicit userinfo audience the provider appends
  for `openid`, and FR-OIDC-6 is read as membership rather than string
  equality — which is how every RFC 7519 §4.1.3 verifier reads it anyway.
- **R11 was never spiked**, and reading 1.7.1 confirmed the hazard: a rotated
  key signs immediately, before any verifier has seen it. `rotate-keys.ts`
  publishes first and signs an hour later.

One thing the provider gets wrong is normalised rather than accepted:
`/oauth2/revoke` answers 400 for an unknown token where RFC 7009 §2.2 requires
200, which would let the endpoint be used as an oracle for which tokens exist.

---

## M9 and M10, and the seven defects they turned up

**M9 — the interrupted authorization.** `/oauth2/authorize` now runs a gate
chain before it forwards: sign in, approval, suspension, forced password
change, in that order, each returning to the authorization it interrupted.

The design changed once it met the library. The plan assumed a
`pending_authorization` table keyed to a cookie; 1.7.1 already carries the whole
request in the interstitial page's query string, signed with the server secret
and stamped with an expiry, and takes it back at `/oauth2/continue`. So there
is no store, no handle and nothing to sweep — and `pending_authorization` stays
in the schema, unused. Removing it would be a migration for no gain; M12's
cleanup job purges it either way. **That is a deviation from the plan, recorded
rather than hidden.**

What _is_ ours is driving the resume. The provider also resumes automatically
whenever a request carrying the signed query sets a session cookie — one gate
too few, because a user with a temporary password gets a session on sign-in and
would receive an authorization code before the forced change. Verified live.

**M10 — the admin surface.** Better Auth's admin plugin does the writes; what
this milestone adds is the deployment's own rules in front of them
(`server/admin/invariants.ts`, enforced by a `before` hook so the admin API and
the admin UI are refused the same things), the five endpoints the plugin has no
equivalent for, and eleven pages. Every button posts to its own route, through
Better Auth, so nothing bypasses the guard or the audit trail.

The whole surface was walked in a browser against a throwaway schema
(`idp_live_m10`, dropped afterwards; the ephemeral bootstrap password never
touched the persistent `idp` schema).

### The defects, all found by running things

1. **`base: "./"` and every knob it broke** — recorded in the S3 note.
2. **The admin API refused API keys (FR-ADMIN-6).**
   `getAuthoritativeSessionFromCtx` re-reads the session past the cookie cache
   by setting `context.session = null` and reading the cookie again. An API-key
   caller has no cookie: the api-key plugin built their session in a `before`
   hook, and the authoritative read threw it away. Every admin endpoint
   answered 401 to exactly the callers FR-ADMIN-6 exists for. The gate now
   falls back to what the hooks resolved — and puts it back, or every later
   hook sees an anonymous request.
3. **The last-admin refusal gave advice nobody could follow.** The self rules
   were checked first, so the only administrator on a deployment who tried to
   demote themselves was told to "ask another administrator". With two
   administrators the last-admin rule does not apply at all, so that message
   was _only ever_ shown to the one person for whom it was wrong. The
   last-admin rule now goes first.
4. **`/idp/admin-stats` answered 500 to everyone.** A bare column beside
   `count()` with no `group by`; Postgres refuses it. Nothing said so until the
   endpoint was actually called.
5. **The whole dashboard answered 500.** A raw ``sql`${col} >= ${date}` ``
   template binds the `Date` with no type for the driver, and Postgres will not
   compare it with a `timestamp`. Drizzle's `gte` does it correctly — and was
   already used, correctly, three files away.
6. **`sessionCookie()` in the test harness took the first match.** Impersonation
   clears the current session before setting the new one, so the first
   `session_token` header is the `Max-Age=0` deletion. The test sent an empty
   token and was told it was not signed in — an hour spent at the wrong end of
   `/admin/impersonate-user`. It now takes the last live one.
7. **An administrative create ignores the `status` it is given.** Not a defect —
   `database-hooks.ts` forces admin-created users active on purpose
   (FR-SIGNUP-2) — but it means a test cannot manufacture a pending user, and
   the approval test now registers one through `/sign-up/email` like a person.

### One thing noticed and deliberately not changed

`buildSessionClaims` decides "did this come from an API key?" with
`typeof session.session.token !== "string"`. In 1.7.1 the api-key plugin sets
`token` to the key **string**, so that test is always false: `azp` is always
`idp` and `apiKeys.tokenClientId` is dead configuration. `tokens.test.ts`
asserts `azp === "idp"` for a key exchange with a comment endorsing it, so the
_behaviour_ is the one that was chosen — but the discriminator and the config
option both claim otherwise. **Left for M11**, where the token surface is
already being revisited; changing token claims mid-M10 would be re-opening a
decision another block made and tested.

---

## M11 — security hardening, and the four things it found

**Headers and the request log.** `server/http/security-headers.ts` puts the
SEC-4 set on every response and `no-store` on the four endpoints that must
never be cached. The CSP concedes `script-src 'unsafe-inline'` because Start
streams framework scripts with no seam for a nonce — recorded as **D36**, with
the rest of the policy written so that concession is contained.

`server/http/request-log.ts` is the SEC-5 line that no milestone had yet
created. It mints a request id at the edge, keeps it in an `AsyncLocalStorage`
for the length of the request, and prints it — so **`audit_log.request_id`,
which has been a column since M4 and empty ever since, is now filled in**. An
event in the trail and a line in the log can finally be put side by side.

Both live in `src/server-entry.ts` rather than `src/serve.ts`, so `vite dev`
gets them too and a developer is not looking at a different application from
the one that ships.

**Rate limits and the client address.** `server/http/client-ip.ts` implements
rightmost-untrusted-hop over `server.trustProxy`, v4 and v6, with 20 unit tests
written from the attacker's side. SEC-2's named endpoints get stricter buckets
through Better Auth's `customRules`; the per-client-id half of the
`/oauth2/token` rule could not be expressed there and is implemented over the
same table instead (**D37**).

**`auth.password.breachCheck` now does something.** Schema'd since M2, wired
now: k-anonymity against Have I Been Pwned, five hex characters on the wire,
padding requested, three-second timeout, and a failure never blocks a password.
Off by default, and DOC-4 has to say that enabling it adds one egress origin.

### What running it turned up

1. **`safeUrlForLog` only redacted at the host root.** It matched
   `/oauth2/` and `/api/auth/` as _prefixes_, so the moment `server.baseUrl`
   grew a path every authorization code would have gone into the log
   (OPS-10). Now matched anywhere in the path — and widened to cover
   `/reset-password`, `/verify-email` and the pages that carry the signed
   `oauth_query`, each of which is a bearer credential in a query string.
2. **The audit trail recorded a spoofable address.** Two call sites read
   `X-Forwarded-For` straight off the request, which is the attacker-controlled
   end of the list. They now pass nothing and the audit writer falls back to
   the address the edge resolved under `server.trustProxy`.
3. **Every caller shared one rate-limit bucket in standalone mode.** With
   `trustProxy: false` the previous code set `ipAddressHeaders: []`, leaving
   Better Auth unable to resolve any address at all — it said so in a warning
   at every boot and nothing had picked it up. Fixed by **D38**.
4. **429s carried a header nothing honours.** Better Auth answers with
   `X-Retry-After`; no browser and no HTTP client does anything with it. The
   edge now copies it onto `Retry-After`.

`security.test.ts` is the TST-5 suite: 22 cases, all written as attacks —
forged `Host`, mass assignment, unregistered redirect URI, PKCE downgrade,
wrong and missing secrets, code replay, uniform answers, cookie attributes, the
approval gate, and a spoofed `X-Forwarded-For` that must not escape the limiter.

Headers verified live on `/login` and `/consent`, the log line and its
redaction verified live, and the request id verified reaching real audit rows —
all against `idp_live_m11`, dropped afterwards.

---

## The dev login (P0'.1) — recoverable now, one command away

**The persistent `idp` schema's bootstrap admin is still stranded**, exactly as
the plan's P0'.1 describes: someone completed the forced password change from
VS Code's embedded browser on 2026-08-24 with a value recorded nowhere, and
`must_change_password` is still true, so the account demands a change that
needs the password nobody has.

Nothing in this session touched it, and nothing needed to. Every live check ran
on a **throwaway schema** created from the same `.env` and dropped afterwards
(`idp_spike_s3`, `idp_live_m6`, `idp_live_m7`, `idp_live_m8a`, `idp_live_m8c`) —
which is what the standing rule asks for and what the runtime-schema machinery
(D27/D29) exists to make cheap. Two supporting changes, both in the gitignored
`config/` folder and therefore uncommitted:

- `config/config.json`'s `database.schema` is now `"${env:IDP_SCHEMA_NAME:-idp}"`,
  so a throwaway schema is one environment variable away;
- `config/oauth_clients.json` now exists with two development clients
  (`dev-web`, `dev-spa`), so the reconcile step has something to do and the M13
  sample RP has a client to use.

**This no longer needs a schema drop, and it no longer needs a decision from
you.** `pnpm reset-admin` is the recovery: it puts the password back to
whatever `.env`'s `IDP_ADMIN_PASSWORD` says, re-arms the forced change, and
ends the stale session. Nothing is destroyed — the user row, its audit history
and its id all survive, which the drop would not have managed.

Against the persistent schema, with no environment override:

```
pnpm reset-admin
```

Then sign in with `IDP_ADMIN_PASSWORD` and choose a new password when the
forced-change page asks. The `drop schema idp cascade` option is retired, and
M14's README lockout section is written around this command instead.

**It has not been run against the persistent `idp` schema.** Every exercise of
it in this session used throwaway schemas (`idp_test_reset_admin_*` from the
integration suite, `idp_cli_check` for the CLI itself, dropped afterwards), per
the standing rule — the one command whose whole purpose is to change a
persistent credential is not one to fire unannounced.

---

## Phase 0 — done, and what it turned up

The three review findings are fixed. Four more problems surfaced while fixing
them, all of which were shipping.

**Your three:** R-1 the reveal control · R-2 the schema-generator premise ·
R-3 the post-login destination. Nothing outstanding from any of them.

**Found on the way, in the order they appeared:**

|         |                                                                                   |
| ------- | --------------------------------------------------------------------------------- |
| **R-4** | The whole server was in the browser bundle, and hydration was dead on every page  |
| **R-5** | The forced password change never ended — the bootstrap admin was trapped for ever |
| **R-6** | Two gates that were green only because nobody ran them                            |
| **R-7** | The advisory-lock timeout never worked; a blocked start would hang, not fail      |

Every one was found by _running_ something rather than reading it: opening the
app in a real browser, signing in end to end against a live server, running the
CLI, running the coverage command. None would have been caught by another pass
over the code.

### R-1 · Password reveal control looks unfinished (FR-ACCT-2, WCAG 2.1 AA)

**Where:** `apps/web/src/components/auth/form-parts.tsx` → `PasswordField`.
Affects `/login`, `/signup`, `/reset-password`, `/change-password`.

**What is wrong:** the reveal is a full-width underlined text link reading
"Show password" / "Hide password" sitting _below_ the input — three of them
stacked on the change-password form. It reads as unstyled scaffolding, not a
product.

**What it should be:** an **icon button inside the field**, right-aligned,
vertically centred — the conventional eye / eye-off affordance. One control that
toggles, not two links that swap. A leading field icon (envelope, padlock) is
the reference the owner gave; the reveal control is the part that matters.

**Why it ended up like this:** the toggle is a hidden checkbox driving the input
through a CSS sibling selector, so it works before hydration and without
JavaScript — which was a deliberate choice for the login page. That constraint
is worth keeping, but it does **not** require an ugly control: the same
checkbox can style a `<label>` containing an SVG, positioned absolutely inside
the field wrapper, with the two icon states swapped by `peer-checked:`.

**Acceptance:**

- icon button inside the input, not a link below it
- one toggling control, not two swapped labels
- `aria-label` that changes with state, and a real focus ring — it is a control,
  so it must be reachable and announced
- ~~still works with JavaScript disabled~~ — **withdrawn by the owner,
  2026-08-24: the site does not need to work without JavaScript** (D31)
- `lucide-react` is already a dependency; no new one is needed

**✅ Fixed.** One in-field eye / eye-off control, right-aligned, Tab reaches it
_after_ the password field with a visible ring, and the accessible name changes
with state. Verified in a real browser, not only in a test.

The toggle flips the input `type` from a `change` handler. Two mechanism notes
worth keeping, because both contradict what the code used to assume:

- Tailwind v4 compiles `peer-checked:` to `:where(.peer):checked ~ *`, a
  **sibling** combinator, so it cannot reach the icons inside the label. Those
  use `group-has-checked:` (`:where(.group):has(:checked) *`). The same hook
  masks the input, which is what lets the checkbox sit _after_ it in the DOM
  and gives the natural tab order.
- `-webkit-text-security: none` on `input[type=password]` is parsed and then
  **clamped back to `disc`** by Chromium 151 and WebKit 26.5; only Firefox 153
  honours it. All three honour it on `input[type=text]`, so the two engines are
  specifically refusing to let a password field be unmasked by style. The
  scriptless reveal this component always claimed therefore only ever worked in
  Firefox — moot now, but it is why the CSS path is a fallback and not the
  mechanism.

A `<noscript>` rule still withdraws the control when scripting is off. It costs
nothing and stops the toggle renaming itself "Hide password" over a masked
field, which would lie to a screen reader. It is no longer load-bearing.

### R-2 · The custom schema generator rests on a false premise (DM-1)

**Where:** `apps/web/scripts/generate-auth-schema.ts`, and every place that
repeats its justification — the deviations table below, the S5 spike note, the
file's own header comment, and the M14 CONTRIBUTING text that has not been
written yet.

**What is wrong:** the generator exists because I concluded the Better Auth CLI
was version-stranded. It is not. The CLI was **renamed**:

|                    |                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `@better-auth/cli` | **deprecated** — _"Package no longer supported"_, last at 1.4.21                                                          |
| **`auth`**         | the current CLI, **1.7.1**, bins `auth` and `better-auth`, depending on `better-auth@1.7.1` and `@better-auth/core@1.7.1` |

Those are exactly our pinned versions, so the version-skew argument — the whole
stated reason for not using DM-1's specified tool — does not hold.

**How it was missed:** I read `@better-auth/cli`'s dist-tags, saw `latest:
1.4.21` against `better-auth@1.7.1`, and stopped. I never checked whether the
package had been renamed, and never ran `npm view @better-auth/cli deprecated`,
which says so outright. A stale `latest` is exactly the shape of a renamed
package, and I read it as an abandoned one.

**What must be re-evaluated — not assumed:**

1. Does `npx auth generate` produce a Drizzle schema equivalent to the committed
   one? Diff it against `auth-schema.ts` before deciding anything.
2. **The open question that may still justify a custom generator:**
   `database.schema` is a _runtime_ value (CFG-4, D27), so the schema module has
   to be a `createAuthSchema(schemaName)` **factory**. The CLI emits constants
   with the name baked in. If it cannot be made to emit a factory, the custom
   generator survives — but for _that_ reason, stated honestly, not the version
   one.
3. If the CLI can serve, delete the generator, switch `db:generate-schema` to
   it, and keep the `--check` drift gate pointed at whatever produces the file.

**Until this is settled, treat the deviations table's "version-stranded" row as
known-false.** The generated schema itself is not in doubt — it is validated
against a real database and by the drift gate — only the reasoning for how it is
produced.

**✅ Settled — recorded as D29. The generator stays, for a different reason.**

I ran the CLI rather than reasoning about it. `auth@1.7.1` installs, runs, and
against a shim of our own option set emits the same **seventeen** tables.
Compared as Drizzle _table objects_ — `getTableConfig()` over every column,
index and foreign key, not a text diff — the two are now **identical across all
17 tables**.

It survives on your point 2, and only that. Where a schema is configured the
CLI emits, from its own source:

```js
code += `
export const ${schemaVarName} = pgSchema(${JSON.stringify(schemaName)});

`
```

A module-level `const` with the name baked in as a string literal. `database.schema`
is a runtime value (D27), so the module has to be a `createAuthSchema(schemaName)`
factory plus `CANONICAL_SCHEMA_NAME`. The CLI has no code path that emits a
function — so it cannot serve, and the pre-decided rule says keep the generator
and state the honest reason. Corrected in the generator header, the S5 spike
note, spec §4 + DM-1, and the deviations table below.

**Running it found two real bugs in ours** — "identical" is only true after
fixing them, and this is the part worth your attention:

|               | ours (before)                        | `auth generate`           |
| ------------- | ------------------------------------ | ------------------------- |
| `required`    | `if (field.required)`                | `attr.required !== false` |
| date defaults | `.toString().includes("new Date()")` | the same test             |

Better Auth documents `required?: boolean` as **`@default true`**. Reading it as
truthy made every field that declares nothing **nullable** — including
`oauth_access_token.token`, which is also `unique`, and Postgres allows any
number of rows to share a NULL under a unique index. `expires_at` on both token
tables went the same way: a token with no expiry was representable. Caught
before M8 wrote a single row; migration `0001_cheerful_korg.sql`.

The second is a curiosity: 1.7.1's default thunk stringifies as `() => new Date`
— **no parentheses** — so a test looking for `new Date()` never matches and
every `.defaultNow()` was silently dropped. **The CLI has the identical bug**;
ours now evaluates the thunk instead of reading its source. A third gap closed
alongside: `field.onUpdate` was ignored, so `session.updated_at` and
`account.updated_at` were not touched on a Drizzle-side update.

Also unified: the schema-name environment variable was `IDP_SCHEMA_NAME` in
`drizzle.config.ts` and `IDP_DB_SCHEMA` in the generated file, and the two could
disagree. Now `IDP_SCHEMA_NAME` everywhere. The generator's hard-coded `"idp"`
is now the `CANONICAL_SCHEMA_NAME` constant it always meant.

### R-3 · Post-login destination is unconfigurable, and its default 404s today

**Where:** `apps/web/src/routes/login.tsx`, `server/config/schema/config-schema.ts`
(the `auth` block), `server/ui-context.ts`. Spec: a new CFG-4 key and a sentence
in FR-AUTH-1; needs a decision number (**D28**).

**Two problems, one fix.**

_It is broken now._ Sign-in redirects to
`safeReturnTo(form.returnTo, APP_ROUTES.account)` — and `/account` does not
exist until M7. **A successful sign-in today lands on a 404.** Only the
bootstrap admin escapes it, because `mustChangePassword` diverts to
`/change-password`, which is why this was not caught: the one account used to
test the flow is the one account that never reaches the default.

_It is unconfigurable._ `/account` is the wrong destination whenever the IdP is
bundled beside the product — at `https://apps.example.com/idp` with the app on
`/`, or with the app on a different host entirely. After signing in, users
should land in the product, not on their profile page.

**Design (decided with the owner):**

- New key **`auth.defaultRedirect`**, default `/account`.
- Accepts a **same-origin relative path or an absolute URL on any origin.** This
  is operator configuration, not user input, so cross-origin is not an open
  redirect. **SEC-3 is unchanged:** the runtime `returnTo` query parameter stays
  same-origin-relative-only, validated by `safeReturnTo` exactly as now.
- **Governs sign-in only.** Sign-up still ends at `/pending-approval` or
  verification, password reset still returns to `/login`, verification keeps its
  own ending. Each flow keeps the ending that makes sense for it.

**Precedence at sign-in, highest first:**

1. a pending OAuth authorization continuation (FR-OIDC-9) — always wins
2. a validated same-origin relative `returnTo`
3. `auth.defaultRedirect`
4. `/account`

**Watch out — the forced-change path.** FR-AUTH-4 interposes
`/change-password` before the destination and currently carries it through the
query as `returnTo`, which `safeReturnTo` rejects for absolute URLs. So when
`auth.defaultRedirect` is absolute it cannot simply be passed through: the
forced-change handler has to re-resolve the destination at the end rather than
round-trip it through a parameter.

**Acceptance:**

- key validates as a relative path or an absolute URL; a bare hostname is rejected
- sign-in honours the precedence above, and an OAuth continuation still wins
- `returnTo` from the query is still refused unless same-origin relative — the
  existing SEC-3 tests must keep passing unchanged
- forced password change reaches an absolute destination correctly
- `config.example` documents it, and the README says to set it when the IdP is
  bundled

**Note on ordering:** this is worth doing _before_ M7. It removes the 404 by
configuration rather than making everyone wait for `/account` to exist.

**✅ Fixed.** Recorded as **D28** in the spec (CFG-4 row, FR-AUTH-1 precedence
sentence, a new AC line, §12.1). The resolver is one exported function,
`server/http/post-login.ts`, so the three places that decide a destination —
sign-in, the 2FA challenge in M6, and the far end of a forced password change
— cannot drift apart. The `pendingContinuation` parameter is already there and
always `undefined`, so M9 changes that module and nothing else.

`server/ui-context.ts` is deliberately untouched: the destination is resolved
server-side and never needs to reach the browser.

---

### R-4 · The whole server was being shipped to the browser — found while fixing R-1

**Not a review finding — found by opening the app in a real browser**, which
R-1 made necessary. The console said:

```
ReferenceError: Buffer is not defined
  at ../node_modules/.pnpm/postgres@3.4.9/.../postgres/src/bytes.js:2:13
```

**The `postgres` driver was in the client bundle, and it killed hydration on
every page.** The production build shipped 1.06 MB to the browser containing
Better Auth, Drizzle, the migrator and this, verbatim:

```sql
select pg_try_advisory_lock($1::int, $2::int) as locked
```

No secrets leaked — those are runtime values, not compiled in — but the
server's _code_ was, and nothing on any page could hydrate.

**Why it happened.** A TanStack Start route `loader` is isomorphic: it runs on
the server for the first paint and in the browser on every client-side
navigation. So a top-level `import { getRuntime }` in a route file pulls the
entire IdP into the client graph — even though only the loader touches it.
Every route did exactly that, `__root.tsx` included. A `server.handlers` block
_is_ stripped from the client build, which is why the POST handlers were fine
and why this looked safe.

**Why nobody noticed.** Every public page is a plain server-rendered form that
works without JavaScript — deliberately, per FR-ACCT-2. With nothing depending
on hydration, a completely dead client bundle is invisible. R-1's reveal
control is the first thing on the site that needs script, and it did not work.

**Fixed.** `server/functions/ui.ts` wraps the one piece of server work the
shell needs in `createServerFn`, whose body the Start plugin compiles out of
the client build. `__root.tsx` fetches it in `beforeLoad` and puts it in the
router context; every child route reads `context.ui`, so it is one RPC per
navigation rather than one per matched route. Client bundle 1.06 MB → 334 kB,
and hydration verified working in Chrome.

**Guarded.** New `scripts/check-client-bundle.ts`, wired into CI: it fails if
any of six server-only strings appears in a client chunk, or if the bundle
crosses a size ceiling. Each marker is also asserted to be _present_ in the
server build, so a marker that stops matching anything fails loudly instead of
passing for ever. Verified by reintroducing a single leaking loader — the gate
catches it.

### R-5 · The forced password change never ended

**Also not a review finding** — found while proving R-3 end to end against a
live server. `mustChangePassword` was **set** by the bootstrap step and
**cleared nowhere in the codebase**. So:

1. sign in with the temporary password → `/change-password?forced=1`
2. change the password → succeeds, session kept
3. sign in again → `/change-password?forced=1`, for ever

FR-AUTH-4 says the flag interposes a change "before anything else completes".
It did. It just never stopped. **The bootstrap admin could not reach any
destination at all** — which is also why R-3's `/account` 404 was reported as
theoretical rather than seen: the one account available to test with never got
past the interposition to hit it.

**Fixed** in `auth/options/database-hooks.ts` via `account.update.after` — the
only seam that fires after the write succeeds _and_ carries both `providerId`
and `userId` (the matching `before` hook receives just `{ password }`, with no
user to act on). Gated on an explicit endpoint list rather than "any credential
password write", because M10's admin temporary-password flow writes a password
**and** raises this same flag; clearing on every write would race it and hand
the user an unforced sign-in. The decision is an exported pure predicate so
that list is asserted without a database.

Verified against a live server: temporary password → forced change → the
configured destination → and the next sign-in goes straight there.

### R-6 · Two more gates that were green only because nobody ran them

Both found while doing the work above, both now real.

**`pnpm lint` was failing at HEAD.** Three shadcn-copied files in
`packages/ui` used inline `type` specifiers, which the TanStack config
rejects. status.md said every gate was green. Fixed in the first commit of
this session.

**The coverage thresholds were decorative — and failing.** TST-1's numbers were
in `vitest.config.ts` but **no CI job ever ran `--coverage`**, so nobody saw
that a run reported ~60 % lines against a 70 % gate. The cause was the
denominator: coverage was measured over the whole of `src/server` from the
**unit** project alone, while the database layer, the auth instance and the
hooks are exercised by the integration project by design.

Measured across both projects the real numbers are 82.9 % lines / 79.4 %
branches, comfortably over TST-1's 70 %. So there is now a `test:coverage`
script that runs both, the integration CI job runs it, and the per-module
85 % gates are extended to the approval modules the plan asked for —
`auth/options/database-hooks.ts` and `auth/plugins/idp-plugin.ts` — with the
tests to clear them. `src/server/oidc/**` was also under its 85 % branch gate
and is now covered.

`packages/ui` also carried both `eslint.config.js` and `eslint.config.ts`.
ESLint resolves `.js` first, so the `.ts` file — which had none of the rule
overrides — was dead weight that would have silently changed the rule set if
the `.js` one ever went away. Deleted.

### R-7 · The advisory-lock timeout never worked

Found by running `pnpm --filter web run db:migrate` — the script this session
was fixing anyway — while a killed process still held the lock. It waited ten
minutes without the `AdvisoryLockTimeout` the code carefully wrote.

`withAdvisoryLock` did:

```sql
SET LOCAL lock_timeout = '60000ms'
```

**`SET LOCAL` outside an explicit transaction block is discarded by Postgres**
with a warning, and every statement there runs in autocommit. So the timeout
stayed at 0 and the wait was unbounded. Every advisory-locked step inherits
this: migrate, first-boot key generation, reconcile, bootstrap admin, cleanup.
Two containers restarting together is the ordinary case (OPS-2), and the
second one would hang silently rather than fail with the actionable message
that was already written for exactly this situation.

Now a session-scoped `SET`, with `RESET lock_timeout` before the connection
goes back to the pool so the next borrower does not inherit it. New
`tests/integration/advisory-lock.test.ts` holds the lock on one connection and
asserts the second gives up, names the lock in the error, honours
`skipIfLocked`, releases on both success and throw, and leaves no
`lock_timeout` behind. **Verified by putting the bug back**: the timeout test
hangs until killed, and passes in seven seconds with the fix.

## Done (M0 spikes, M1–M5)

**M1.0 — spec amended** for D24–D26: social profile-sync collision now blocks
sign-in, no social/sign-up warning, and M2M removed throughout (FR-OIDC-1/3/7,
CFG-4/5, SEC-6, TST-4, DOC-3, §12, §15 ticked).

**M0 spikes** — findings recorded in [docs/spikes/](docs/spikes/):

- **The 1.7.x plugins moved.** `oauth-provider` and `api-key` are now separate
  packages (`@better-auth/oauth-provider@1.7.1`, `@better-auth/api-key@1.7.1`),
  so three packages have to move in lockstep on every upgrade. Reading their
  real type surface is also what froze the FR-OIDC-3 mapping (R9) and settled
  R4, R5 and R10.
  ⚠ The _second half_ of this finding — that the CLI was unusable — **was
  wrong**; settled as **D29**, see **R-2** under Review results. The CLI runs
  fine at 1.7.1; the generator survives because the CLI cannot emit a
  schema-name factory, and running it found two real bugs in ours.
- **Session advisory locks do not hold through the pooler** but do through the
  direct endpoint. This forced a new config key, `database.directUrl` (recorded
  as D27), used by every locked step. Without it two containers starting
  together would each believe they held the migration lock.
- R1 (default audience) and R4 (secret hashing) both turned out to have
  supported seams — no `pnpm patch` needed. R2 confirmed:
  `enforcePerClientResources` defaults on.

**M1–M5** — toolchain pinned with a CI gate against floating ranges; the full
CFG-1..6 config system; database, migrations and the Better Auth instance; the
OPS-2 startup sequence; audit trail, e-mail and i18n; and the public auth UI
with the approval endpoints. **157 unit + 54 integration tests**, the latter
against the real Neon database.

Two things I'd flag: **`database.schema` was briefly hard-coded** and you caught
it — it's now a runtime value end to end, with the migrator retargeting the
schema identifier in the committed SQL. And **`buildRuntime` had to become
async**, because the OAuth provider queries `oauth_resource` from its own
`init()`; on a fresh database the process died before it could migrate.

## Not done (the rest of M13, and M14)

The e2e flow specs, axe, the sample RP and the CI e2e job; then docs and the
release. What M13 has so far is above.

Accepted deviations, unchanged: `drizzle.config.ts` sits in `apps/web/`
because drizzle-kit resolves paths relative to itself; `.agents/skills/` is
committed tooling.

**`test:e2e` is no longer inert.** `pnpm --filter web test:e2e` drives the
built image in a browser, in both deployment shapes. That was the gap that let
a sign-in page with no stylesheet pass every gate for four milestones.

Deviation **D33**, unchanged: `pending_authorization` is generated into the
schema and never written to — 1.7.1's signed continuation makes the store
unnecessary. See the M9 section above.

`src/serve.ts` is the `Bun.serve` wrapper spike S3 needed — static files out of
`dist/client` with the mount path stripped — and now also carries M12's OPS-4
signal handling. The SEC-5 request log and the SEC-4 headers live one layer
down in `src/server-entry.ts`, so `vite dev` gets them too. In the image both
it and the CLI are **bundled**, not copied as source: the final stage has no
`src/`.

---

## What responds today

|                                                                                                                    |                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `/`                                                                                                                | ✅ 307 → `/account` when signed in, `/login` when not |
| `/login` `/signup` `/two-factor` `/change-password` …                                                              | ✅ 200                                                |
| `/account` `/account/security` `/account/sessions` `/account/api-keys` `/account/consents`                         | ✅ 200                                                |
| `/healthz` `/readyz`                                                                                               | ✅ 200                                                |
| `/.well-known/openid-configuration`                                                                                | ✅ 200 — issuer-root URLs, no `/api/auth` anywhere    |
| `/.well-known/oauth-authorization-server`                                                                          | ✅ 200                                                |
| `/.well-known/jwks.json` `/api/auth/jwks`                                                                          | ✅ 200, byte-identical, ETag + `max-age=300`          |
| `/.well-known/change-password`                                                                                     | ✅ 302 → `/change-password`                           |
| `/.well-known/security.txt`                                                                                        | ✅ 200 with a file in the config folder, 404 without  |
| `/robots.txt`                                                                                                      | ✅ 200, disallow all                                  |
| `/oauth2/authorize` `/oauth2/token` `/oauth2/userinfo` `/oauth2/introspect` `/oauth2/revoke` `/oauth2/end-session` | ✅ 200 / 405 by method                                |
| `/admin/*`                                                                                                         | ✅ 200 for an administrator, 404 otherwise            |
| `/branding/*`                                                                                                      | ✅ 200 from the config folder, 404 for anything else  |

**A full authorization-code + PKCE flow works end to end**, verified against a
live server on a throwaway schema: authorize → code → token (ES256, `kid`,
`typ: at+jwt`, `iss` byte-equal, user claims, `no-store`) → userinfo. The CORS
matrix answers four different ways depending on the endpoint and origin.

What is still missing from the OIDC surface is _interaction_: the consent
screen, the pending-authorization continuation and the end-session
confirmation page are M9. `/oauth2/end-session` forwards today but has no
confirmation page for the no-hint case.

---

## Milestone table

| #    | Milestone                                         | Status                                                                                |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| M1.0 | Amend spec for D24–D26                            | ✅ done                                                                               |
| M0   | Spikes S1, S2, S3, S4, S5                         | ✅ done — S3's verdict is in [docs/spikes/s3-sub-path.md](docs/spikes/s3-sub-path.md) |
| P0   | Phase 0 — review fixes + M5.5 backfill + CI       | ✅ done                                                                               |
| M1   | Toolchain baseline                                | ✅ done                                                                               |
| M2   | Configuration system                              | ✅ done                                                                               |
| M3   | DB, Better Auth skeleton, migrations              | ✅ done                                                                               |
| M4   | Startup, bootstrap admin, audit, e-mail, i18n     | ✅ done                                                                               |
| M5   | Password auth, sign-up & approval                 | ✅ done                                                                               |
| M6   | Social + 2FA                                      | ✅ done                                                                               |
| M7   | Account self-service + API keys                   | ✅ done                                                                               |
| M8   | **OIDC core**                                     | ✅ done — a, b and c                                                                  |
| M9   | Authorize UX: continuation, consent, end-session  | ✅ done                                                                               |
| M10  | Admin UI + API                                    | ✅ done                                                                               |
| M11  | Security hardening                                | ✅ done                                                                               |
| M12  | Container, compose, Caddy, CLI, ops               | ✅ done — image, compose, both Caddyfiles, all seven CLI commands, cleanup job, TST-8 smoke |
| M13  | E2E, sample RP, a11y                              | 🟨 **in progress** — harness + rendering specs green in both shapes; flows, axe and the sample RP to come |
| M14  | Docs & release — **including the README (DOC-1)** | ⬜ not started                                                                        |

`README.md` is **DOC-1, in M14**. It currently carries a minimal
getting-started and first-sign-in section; the full DOC-1 README — features,
architecture, generated configuration reference, provider setup, runbooks,
troubleshooting — is still to come.

---

## Commits

This session, newest first:

```
004ac26 feat(m13): the browser gate, and the sub-path deployment nobody had driven
b0c9641 docs(ops): make the resolved SSL mode visible, and stop naming a command that never existed
fb0e5a1 feat(m12): the image, and seven things that only running it could find
94a0ae7 docs(status): point the handoff at the commit it describes
22db5a3 fix(dev): the sign-in page had no CSS, and no gate could see it (+ M12 lifecycle)
cffdc65 feat(security): headers, the request log that never existed, and real rate limits (M11)
1c56e9f feat(admin): the admin surface, and the rules Better Auth has no opinion about (M10)
c0d8d8e feat(oidc): interstitials that resume the authorization (M9)
e030111 feat(m8c): the protocol endpoints move to the issuer root
d46433e feat(m8b): tokens that say the same thing whichever endpoint minted them
0e09f43 feat(m8a): the client file becomes the database, and the R4 risk dissolves
c8edfc2 feat(m7): the account area, API keys, and a re-authentication gate
c759412 feat(m6): the second factor, and social identities that stay in their lane
6046bf4 feat(s3): one build that serves the host root and /idp
```

Phase 0, newest first:

```
a89ba87 feat(cli): make `db:migrate` real, and fix the lock timeout it exposed
b3fbabf fix(ui): translate the two notice codes nothing handled, drop a dead branch
8c4923b feat(audit): SEC-6 â€” record what Better Auth does, and make the coverage gate real
612dcbc feat(signup): FR-SIGNUP-2 â€” actually notify the administrators
9256dc7 ci: run the integration suite against a real Postgres
9a1804c fix(db): R-2/D29 â€” settle the generator question, and fix what asking it found
365064b fix(auth): FR-AUTH-4 â€” let the user out of the forced password change
ac85464 fix(build): keep the server out of the browser bundle
6d975ad feat(auth): R-3/D28 â€” auth.defaultRedirect, resolved in one place
fb989fe docs(spec): D28 â€” auth.defaultRedirect, the post-sign-in destination
2f9865c chore(skills): install the agent-browser skill
fbee5ba fix(ui): R-1 â€” password reveal as an in-field icon control
31e08c6 fix(ui): restore the lint gate â€” top-level type-only imports
```

Everything before this session:

```
520d786 docs(status): record R-3 - post-login destination unconfigurable and 404s today
8f35357 docs: correct the CLI finding - the Better Auth CLI was renamed, not abandoned
b319c98 docs(status): add review-results section; clarify the search_path finding
896cab1 docs: say plainly that there is no default login, and what to type instead
099f47b docs: rewrite status.md around the Done/Not-done summary, add README getting started
0268b73 fix: replace the starter page at / with a redirect to /login
17de4f9 docs: add status.md with where the plan stands
ae7851a feat(m5): public auth UI and the approval endpoints
922b9c2 feat(m4): i18n catalog, e-mail transport and the nine templates
e56d021 feat(m4): startup sequence, bootstrap admin, audit trail, health endpoints
d90ddb3 feat(m3): database layer, Better Auth instance, migrations, approval gate
7115db8 feat(m1,m2): toolchain baseline, config system, first spike findings
43f019c docs(spec): add spec-v0/v1 and amend v1 for owner decisions D24-D26
```

---

## The spike findings in detail

Notes are in [docs/spikes/](docs/spikes/); S4 is re-runnable with
`pnpm --filter web exec bun run scripts/spike-s4-schema-placement.ts`.

### The 1.7.x plugins moved (S5)

`oauth-provider` and `api-key` are **separate packages** in 1.7.x
(`@better-auth/oauth-provider@1.7.1`, `@better-auth/api-key@1.7.1`). Three
packages now have to move in lockstep on every upgrade. Reading their real type
surface is what froze the FR-OIDC-3 client mapping (R9) and settled R4, R5 and
R10.

> ⚠ **This spike also concluded the CLI was unusable. That was wrong** — the CLI
> was renamed from `@better-auth/cli` (now deprecated) to **`auth`**, which
> tracks 1.7.1. See **R-2** under Review results. The Drizzle schema is
> currently generated by `apps/web/scripts/generate-auth-schema.ts` from the
> installed `getAuthTables()`; whether that should remain is R-2's open
> question.

### Session advisory locks do not hold through a pooler (S4 → **decision D27**)

With the lock held on one reserved connection, `pg_try_advisory_lock` on a
second connection through the **pooled** endpoint _succeeds_. Through the
**direct** endpoint it behaves correctly. Every mutating startup step depends on
this — migrations, first-boot key generation, reconciliation, bootstrap admin,
cleanup.

**Resolution:** new config key **`database.directUrl`** (spec amended, D27
recorded, §13 R8 closed). Every locked step opens its connection with
`createDb(config, { direct: true })`; request traffic keeps the pooled URL.
Startup warns when the URL looks pooled and `directUrl` is unset.

### Risks that resolved better than expected

| Risk                         | Outcome                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** default audience      | Real — no `resource` parameter yields an _opaque_ token, not a JWT. Fixed by a `hooks.before` injection; **the pre-authorized `pnpm patch` is not needed**. The wrinkle it recorded — a second `aud` from the `openid` scope — could _not_ be normalised in the `jwt.sign` seam, because that seam requires a remote key set; settled as **D32**. |
| **R2** per-client resources  | Confirmed: `enforcePerClientResources` defaults to `true`. Kept on; reconcile owns the links.                                                                                                                                                                                                                                                     |
| **R4** client-secret hashing | Resolved outright — `storeClientSecret` accepts our own `hash`/`verify` pair, so reconcile and the token endpoint use the same function object.                                                                                                                                                                                                   |
| **R5** session JWT           | Half right. `definePayload` is the seam for the session JWT and one claims builder does cover all three FR-OIDC-7 paths — but **not** through `jwt.sign`, which the plugin refuses to accept without a remote key set (D32).                                                                                                                      |

---

## What exists in the tree

**Configuration (CFG-1..6)** — `apps/web/src/server/config/`
JSONC with `$schema` exemption · full D18 placeholder grammar · zod schemas for
all three files covering the whole CFG-4 inventory · every CFG-5 cross-check
including production-literal-secret detection and the Entra tenant lock ·
masking · CFG-3 precedence · JSON Schema export with a staleness gate · a
committed `config.example/` the tests load.

A security hole was found and closed while writing the tests: a secret supplied
through a placeholder's inline default (`${env:UNSET:-hunter2}`) is literal text
in the file, so it no longer satisfies the production rule.

**Database (DM-1..5)** — `apps/web/src/server/db/`
17 tables + the drizzle journal, all schema-qualified, nothing in `public` ·
runtime-resolved schema name · own migrator (drizzle's cannot retarget a schema)
keeping drizzle's table name, hash scheme and per-migration transaction ·
namespaced advisory locks on a dedicated reserved connection.

**Auth instance** — `apps/web/src/server/auth/`
All six plugins wired with every option traced to a requirement · account
linking fully disabled (FR-SOC-2) · `additionalFields` per DM-3/FR-AUTH-7 ·
telemetry off (SEC-8) · oauth-provider restricted to the two v1 grants (D26),
client CRUD denied, resources seeded · `databaseHooks` as the single enforcement
point for the approval gate, domain restriction and status assignment · a
before-hook normalising e-mail ahead of validation.

**Startup (OPS-2)** — `apps/web/src/server/startup.ts`
migrate → signing key → reconcile clients → validate roles → bootstrap admin,
every mutating step under an advisory lock on the direct connection, failures
surfacing as one actionable `StartupError`. FR-ADMIN-1's "two boots create
exactly one admin" holds.

**Public UI (FR-ACCT-2)** — `apps/web/src/routes/`
Server-rendered plain forms, so the login page works before hydration and
without JavaScript. Posts forward the original headers (so the CSRF origin check
applies), answer 303, and carry failures as an error **code** — wording comes
from the catalog, user input never reaches a URL, and wrong-password and
unknown-address collapse to one code (SEC-7).

**OIDC (FR-OIDC-2..17)** — `apps/web/src/server/oidc/`, `apps/web/src/server/claims/`
Client reconciliation in one transaction under an advisory lock, with the
shared `{hash, verify}` pair the token endpoint verifies with (R4) · one claims
builder for all three token shapes · the R1 default-resource injection · scoped
token revocation (user / session / client) · the FR-OIDC-13 absolute refresh
ceiling · the issuer-root protocol proxy with the discovery rewrite, the CORS
matrix and the RFC 7009 normalisation · publish-then-sign key rotation (R11).

**Account area (FR-ACCT-1, FR-KEY-1)** — `apps/web/src/routes/account/`
Profile, security (password, e-mail, 2FA enrolment with a server-rendered QR),
sessions, API keys and connected applications, every sensitive POST behind the
FR-AUTH-5 freshness gate reading authoritative session state.

**Also in place:** structured logger with SEC-5 redaction · SEC-6 audit trail ·
Resend and capture transports with all nine templates · typed en-US catalog with
FR-I18N-1 locale resolution · `/healthz` and `/readyz` · approve/reject
endpoints gated on `admin.adminRoles` · CI with lint, typecheck, unit,
dependency-pinning, schema-drift and config-schema gates, plus a nightly audit.

---

## What is left, in detail

**M9 — Authorize UX.** The pending-authorization store over the existing
`pending_authorization` table, the gate chain (login → status → 2FA → forced
change → consent → resume), the consent screen, the end-session confirmation
page and `routes/error.tsx`. `/oauth2/end-session` forwards today; the no-hint
case needs a page before it can act, because ending a session on an
unauthenticated GET is a CSRF surface.

**M10 — Admin UI + API.** `/admin/*` entirely, the invariants module (last
admin, no self-ban, no self-role-change), impersonation behind
`admin.allowImpersonation`, and the admin API endpoints FR-ADMIN-6 documents.

**M11 — Security hardening.** Already in place: SEC-1 (every URL from
`baseUrl`), SEC-3, SEC-5 redaction, SEC-6, SEC-7, SEC-9, SEC-10, and now the
FR-OIDC-17 CORS matrix. Still to do: the SEC-4 headers/CSP middleware, the
SEC-5 _request log_ (which no milestone has created yet — audit rows still
carry no request id), the SEC-2 rate-limit rules with `trustProxy` IP
resolution, `auth.password.breachCheck`, and the TST-5 adversarial suite.

**M12 — Container and ops.** The remaining CLI commands (`config validate`,
`create-admin`, `rotate-keys`, `cleanup` — `migrate` and `reconcile-clients`
exist), the cleanup job, SIGTERM draining on top of `src/serve.ts`, the
Dockerfile, compose, both Caddyfiles and the smoke test.

**M13 — E2E, sample RP, a11y.** Playwright against the built image at both
mount points, the `openid-client` sample RP, axe. The TST-7 mock OIDC provider
already exists as `src/tests/fixtures/mock-oidc-provider.ts` and is written as
a real listener precisely so the containerised run can reuse it.

**M14 — Docs and release.** The generated configuration reference, the DOC-1
README rewrite (including the first-sign-in trap: the forced change _consumes_
the `.env` password), `docs/neon.md`, `docs/clients.md`,
`docs/admin-api.md`, the runbooks, and the release gate.

---

## Deviations from the plan

| Deviation                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema generated by `scripts/generate-auth-schema.ts`, not the Better Auth CLI  | **Verified, D29.** The old "version-stranded CLI" reason was false — the CLI was renamed to `auth` and tracks 1.7.1. The real reason: the CLI emits module-level constants with the schema name baked in as a string literal, and a runtime `database.schema` (D27) needs a `createAuthSchema(schemaName)` factory it has no code path to produce. Both now emit field-identical output across all 17 tables. |
| Own migrator instead of `drizzle-orm`'s                                         | Drizzle's applies the file verbatim and cannot retarget `database.schema`, which is a runtime setting.                                                                                                                                                                                                                                                                                                        |
| `drizzle.config.ts` in `apps/web/`, not the repo root                           | drizzle-kit resolves every path relative to the config file, and both the schema and the migrations live there.                                                                                                                                                                                                                                                                                               |
| New config key `database.directUrl`                                             | Forced by the S4 pooler finding; recorded as D27 and amended into CFG-4.                                                                                                                                                                                                                                                                                                                                      |
| Route loaders read `context.ui`, filled by one `createServerFn` in `beforeLoad` | A Start `loader` is isomorphic, so a top-level `getRuntime` import puts the whole IdP in the browser bundle. See R-4.                                                                                                                                                                                                                                                                                         |
| Coverage is measured across **both** vitest projects, not `unit` alone          | Measuring all of `src/server` against unit tests only is the wrong denominator, and reported ~60 % against its own 70 % gate. See R-6.                                                                                                                                                                                                                                                                        |
| The reveal control is withdrawn when scripting is off                           | Blink and WebKit clamp a password field back to `disc` whatever the style says, so a scriptless toggle would lie to a screen reader. Cheap and no longer load-bearing after D31. See R-1.                                                                                                                                                                                                                     |
