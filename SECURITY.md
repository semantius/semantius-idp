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
- configuration handling: placeholder substitution, secret masking, anything
  that puts a secret in a log or a response;
- the container: what it runs as, what it can write, what it exposes.

## What is not

These are documented behaviours rather than defects. If you think the reasoning
is wrong, say so — but they will not be treated as vulnerabilities.

- **An issued access token stays valid until it expires.** Offline validation
  is the point; the window is `oauth.accessTokenTtl`, 15 minutes by default.
  Revocation is immediate everywhere the IdP is actually asked.
- **`script-src 'unsafe-inline'`.** The framework streams its own scripts with
  no seam for a nonce. The rest of the policy is written so this is the only
  concession — no remote origin anywhere, `connect-src 'self'`, `form-action`
  limited to this origin and the registered redirect origins.
- **Sign-up enumeration.** Forgot-password, resend-verification and sign-in
  failures answer uniformly. Sign-up itself cannot: creating an account that
  already exists has to fail. Rate limits and verification-first are the
  mitigation, and the residual risk is accepted.
- **API keys bypass two-factor authentication.** A key is a credential its
  owner created deliberately; it re-checks their standing on every use, but it
  does not prompt.
- **Running with `server.allowInsecureHttp`, or with rate limiting off.** Both
  are development switches and both say so.
- **Anything requiring database or configuration-folder access.** Someone who
  can read `config.json` already has the secret.

## Supported versions

The latest minor release. Fixes go to `main` and a patch release; older minors
are not backported.

## Handling

A confirmed vulnerability gets a private advisory, a fix, and a release. The
advisory is published once the fix is available, and credits the reporter
unless they ask otherwise.
