# Security policy

## Reporting a vulnerability

Please report privately, not as a public issue.

Use GitHub's private
[security advisory](https://github.com/semantius/semantius-idp/security/advisories/new)
form. It is the only reporting channel, and it is private until an advisory is
published.

Include enough to reproduce it: the version or commit, the configuration that
matters, and what an attacker gets. A proof of concept is welcome and never
required.

You will get an acknowledgement within three working days and an assessment
within ten. If we disagree that something is a vulnerability, you will get the
reasoning rather than silence.

Please do not test against a deployment you do not run.

## What is in scope

Anything that lets someone authenticate as another user, obtain a token they
should not have, read another user's data, or escalate to an administrator.
Specifically:

- authentication and session handling, including the approval, suspension and
  forced-password-change gates;
- the OAuth 2.1 / OIDC surface: code and PKCE handling, token issuance, the
  claim set, revocation, consent, RP-initiated logout;
- the admin area and the admin API, including the last-administrator and
  self-action invariants;
- the `/gateway/*` reverse proxy: credential exchange, what is forwarded, what
  is stripped, and where a request can be made to go;
- configuration handling: placeholder substitution, secret masking, anything
  that puts a secret in a log or a response;
- the container: what it runs as, what it can write, what it exposes.

## What is not

These are documented behaviors rather than defects. If you think the reasoning
is wrong, say so — but they will not be treated as vulnerabilities.

- **An issued access token stays valid until it expires**, as any signed JWT
  does: offline validation is the point, and nothing short of introspection can
  end a token early. The window is `oauth.accessTokenTtl`, 15 minutes by
  default. Revocation is immediate everywhere the IdP is actually asked.
- **`script-src 'unsafe-inline'`.** The framework streams its own scripts with
  no seam for a nonce. The rest of the policy is written so this is the only
  concession — no remote origin anywhere, `connect-src 'self'`, `form-action`
  limited to this origin and the registered redirect origins.
- **API keys bypass two-factor authentication, and an administrator's key is
  an administrator.** Standard for a bearer credential: a key is not a
  sign-in, so no second factor applies to it. It re-checks the owner's
  standing on every use, and it carries every role its owner holds — there is
  no per-key scope in v1. Keep an administrator's key where you keep the
  administrator's password.
- **The SQL console is off by default, and on, it is the database role.**
  When an operator enables `admin.database`, an administrator's key runs SQL
  as the role `DATABASE_URL` names: it reads every row, and in `read-write`
  mode it can delete the audit trail. The reference deployment gives that
  role no superuser rights; a superuser connection is reported at start-up.
- **A gateway reaches what its operator points it at.** `/gateway/*` is an
  authenticating reverse proxy to an operator-named upstream, private
  addresses included; only link-local addresses are refused. A gateway with
  `requireAuth: false` forwards anonymous traffic by design.
- **"Trust this device" is a cookie**, as it is everywhere this feature
  exists. The checkbox on the two-factor challenge page stores a random
  token in a cookie; nothing ties it to the browser, so a copy of that cookie
  skips the second factor on any machine until the device is revoked on
  `/account/security` or three `twoFactor.trustDeviceDays` windows have
  passed since it was first trusted.
- **Second factors are recoverable from the database plus `secret`.** TOTP
  secrets and backup codes are encrypted with `secret`, not hashed, because the
  TOTP algorithm needs the secret back. Database read access together with
  the configuration secret recovers them — the SQL console is such access,
  and start-up warns when it is on alongside two-factor authentication.
- **Anything requiring access to the process environment or the database**,
  which is the trust boundary of any service. The secret lives in `.env` and reaches the IdP through its environment;
  `config.jsonc` only names it. Whoever can read that environment, or the
  database, already holds what the IdP protects.

## Supported versions

The latest minor release. Fixes go to `main` and a patch release; older minors
are not backported.

## Handling

A confirmed vulnerability gets a private advisory, a fix, and a release. The
advisory is published once the fix is available, and credits the reporter
unless they ask otherwise.
