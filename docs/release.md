# Release checklist

Everything automated runs in CI. This file is the part that cannot be: three
identity providers whose consoles nobody can script against, and one real
database that has to accept a real token.

Work through it on a **staging deployment with public HTTPS** — social
callbacks and JWKS fetches both need to reach it from the internet.

## Before tagging

### The automated gates

All green on the commit being tagged. CI runs them; this is the list to check
against, not to re-run by hand:

- lint, typecheck, unit, integration with coverage thresholds
- dependency pinning, config JSON Schemas, the configuration reference,
  database schema drift
- the client-bundle check
- the image build, the container smoke test and the Trivy scan
- end-to-end in a browser, both deployment shapes

### The documentation

- [ ] [CHANGELOG.md](../CHANGELOG.md) has an entry for this version, with the
      `D` numbers of any spec amendments.
- [ ] [spec-v1.md](../spec-v1.md) is amended through the last decision the code
      actually implements.
- [ ] The README's quick start still matches what the smoke test does.
- [ ] `config.example/` still validates — CI checks this, but check the
      comments still describe the current behaviour. `config-schema/` is
      generated; `config:schemas --check` is the gate that proves it.

## Social sign-in (TST-7)

The mock provider in the integration suite proves the *flow*. It cannot prove
that a real console is configured correctly, that the callback URL is exactly
right, or that the provider still returns the claim we key identities on. Those
are the failures that only appear in production, so they are checked by hand
before each release.

For each provider, on staging:

### Google

- [ ] The callback URL registered in the Google console is
      `{baseUrl}/api/auth/callback/google`, character for character.
- [ ] Signing in with a **new** account creates a user with the right name and
      address.
- [ ] Signing in again with the **same** account signs in to the same user —
      not a second one.
- [ ] Changing the display name at Google and signing in again updates it here
      (`syncProfile`).

### GitHub

- [ ] Callback `{baseUrl}/api/auth/callback/github`.
- [ ] New account, then repeat sign-in, as above.
- [ ] An account whose GitHub e-mail is **private** still signs in, and the
      address recorded is the one GitHub reports as primary.

### Microsoft Entra

- [ ] Callback `{baseUrl}/api/auth/callback/microsoft`.
- [ ] `social.microsoft.tenantId` is a real tenant GUID or verified domain.
      `common`, `organizations` and `consumers` are refused at start-up — check
      that refusal still happens by trying one.
- [ ] New account, then repeat sign-in.
- [ ] The identity is keyed on the tenant's immutable object id, so **renaming
      the account's UPN and signing in again reaches the same user**. This is
      the check that matters most: keying on e-mail instead would silently
      create a second account.

### For all three

- [ ] With `signUp.enabled: false`, an identity that does not already exist is
      **refused** — social sign-in is not a way around a closed registration.
- [ ] With `signUp.requireApproval: true`, a new social account lands in the
      queue rather than signing straight in.
- [ ] An address that already belongs to a different account is **refused**,
      not merged, and `social.profile_conflict` appears in the audit log.

## One real token against Neon

The Neon constraints test asserts the shape. This asserts that Neon agrees.

- [ ] Create (or reuse) a Neon project and register the staging deployment's
      JWKS URL: `{baseUrl}/.well-known/jwks.json`.
- [ ] Configure the audience in Neon to match `jwt.audience`.
- [ ] Sign in on staging and take a token:

      ```bash
      curl -s -H "Cookie: $COOKIE" {baseUrl}/api/auth/token | jq -r .token
      ```

- [ ] Use it against the Neon project and confirm a row-level-security policy
      keyed on `auth.user_id()` sees the right user.
- [ ] Confirm `role: "authenticated"` from `jwt.claims` reaches Postgres — a
      query that requires the `authenticated` role succeeds.
- [ ] Rotate the signing key (`idp rotate-keys`) and confirm tokens issued
      **before** the rotation still verify, and new ones do too. This is the
      grace-period behaviour, and getting it wrong is invisible until a
      rotation happens in production.

## A last look at the deployment

- [ ] On an **empty** database, the root leads to `/setup`, completing it
      creates a working administrator, and `/setup` then redirects to `/login`
      and stays that way (**D52**).
- [ ] `/readyz` is 200 and `/healthz` answers without touching the database.
- [ ] Discovery's `issuer` is byte-for-byte `server.baseUrl`.
- [ ] Under a sub-path, the origin-root RFC 8414 document answers:
      `{origin}/.well-known/oauth-authorization-server{path}`.
- [ ] A `SIGTERM` (`docker/idp-stop.sh`) exits 0 within the grace period.
- [ ] The audit log has rows for the sign-ins just performed, with sensible
      actors.

## Tagging

**This step needs the owner's sign-off.** It publishes an image under a name
people will pull.

```bash
git tag -s v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

The tag builds amd64 and arm64, pushes `1.0.0`, `1.0`, `1`, `latest` and
`sha-<commit>`, attaches an SBOM and uploads the vulnerability scan. A merge to
`main` does none of that — only a tag publishes.

## After

- [ ] Pull the published image on a clean machine and run the README's quick
      start against it, end to end.
- [ ] Confirm the tag set is on the registry and `latest` points where it
      should.
- [ ] Open the next `## [Unreleased]` section in the changelog.
