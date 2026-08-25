# Runbooks

Short procedures for the things that happen to a running deployment. Each one
says what it changes, what it does not, and how to tell it worked.

Every command below has the same two shapes:

```bash
docker compose exec idp idp <command>    # against a running container
pnpm --filter web exec bun src/cli/index.ts <command>   # from a checkout
```

`idp config validate` prints the effective configuration with secrets masked
and exits non-zero if anything is wrong. Run it first whenever a change did not
take effect.

---

## Upgrading

Migrations are **forward-only**. There is no downgrade path, so a backup taken
before the upgrade is the only way back.

```bash
pg_dump "$DIRECT_DATABASE_URL" --schema=idp -Fc -f idp-before-upgrade.dump

docker compose pull
docker compose up -d --wait
curl -fsS localhost:3000/readyz
```

Migrations run on boot under an advisory lock, so a container that starts
while another is still migrating waits rather than racing. `/readyz` reports
`migrations: false` until they finish, which is what `--wait` is watching.

If start-up fails, the log carries **one** actionable error and the container
exits non-zero — it does not limp along in a half-migrated state. Restore the
dump and pin the previous tag:

```bash
docker compose down
psql "$DIRECT_DATABASE_URL" -c 'drop schema idp cascade'
pg_restore -d "$DIRECT_DATABASE_URL" idp-before-upgrade.dump
IDP_IMAGE=ghcr.io/adenin/semantius-idp:1.2.3 docker compose up -d --wait
```

**Pin a version in production.** `latest` means the next `docker compose pull`
is an upgrade nobody scheduled.

---

## Rotating the signing key

Routine, and safe. A new key is created and **published before it signs
anything**; the retired one keeps verifying for `jwt.gracePeriod` (by default
the longest token lifetime plus an hour, comfortably longer than the one-hour
JWKS cache a verifier like Neon keeps).

```bash
docker compose exec idp idp rotate-keys
```

or the **Rotate the signing key now** button on `/admin/system`.

Verify:

```bash
curl -s https://idp.example.com/.well-known/jwks.json | jq '.keys | length'
# 2 during the grace period, back to 1 after the cleanup job retires the old one
```

Nothing to do for clients. Tokens signed by the old key keep verifying until it
leaves the key set, and every verifier re-fetches on an unknown `kid`.

Automatic rotation happens every `jwt.rotationInterval` without anyone asking.

---

## Rotating `secret`

**Not routine.** `secret` encrypts the signing keys in the `jwks` table, so
changing it makes every existing key undecryptable — and invalidates every
session at the same time.

What breaks, in order:

1. every browser session, immediately — everyone signs in again;
2. every signing key, so **new tokens cannot be signed** until a fresh key
   exists;
3. every token already issued, once the old key set is gone.

The sequence:

```bash
# 1. Announce it. Every verifier will need to re-fetch the key set, and every
#    token in flight will stop verifying.

# 2. Stop the IdP.
docker compose stop idp

# 3. Delete the key rows. They cannot be decrypted with the new secret and a
#    stale row is worse than no row.
psql "$DIRECT_DATABASE_URL" -c 'delete from idp.jwks'

# 4. Put the new secret in place, then start.
docker compose up -d --wait idp

# 5. A fresh key is generated on the first boot. Confirm it:
curl -s https://idp.example.com/.well-known/jwks.json | jq '.keys[0].kid'
```

Then tell every resource server to re-fetch. Neon does so within its cache
window; a service holding a hard-coded key set needs a deploy.

If you can avoid this, avoid it. Rotating the *signing key* is the routine
operation and does none of the above.

---

## Reconciling clients

`oauth_clients.json` is applied at start-up, so the ordinary way to change a
client is to edit the file and restart. To apply it without a restart:

```bash
docker compose exec idp idp reconcile-clients
```

What it does, transactionally and under an advisory lock:

- inserts clients that are new;
- updates ones that changed, re-hashing the secret if it changed and keeping
  `createdAt`;
- **disables** clients that are no longer in the file, and revokes their tokens
  and consents;
- deletes them instead when `oauth.reconcile.prune` is true;
- seeds resources and links each client to the default audience and its own.

The diff is written to the audit log, and `/admin/clients` shows the last
reconcile time and any warnings.

A validation failure aborts the whole thing — no partial application — and at
start-up it aborts the boot. That is deliberate: a half-applied client file is
a deployment nobody can reason about.

---

## Cleanup

An in-process job runs every `cleanup.intervalMinutes` (60 by default) with
jitter and an advisory lock, so replicas cannot duplicate the work. To run it
now:

```bash
docker compose exec idp idp cleanup
```

What it purges, and why each is safe:

| Table | When |
| --- | --- |
| `session` | expired |
| `verification` | expired — reset links, verification links **and authorization codes** |
| `oauth_access_token`, `oauth_refresh_token` | dead for 30 days, expired or revoked |
| `oauth_client_assertion` | expired; the replay window is over |
| `pending_authorization` | expired |
| `rate_limit` | untouched for a day, so past every window |
| `jwks` | expired **plus** the grace period |
| `audit_log` | older than `audit.retentionDays` |

The thirty-day delay on token rows is evidence, not caution. "Was this token
revoked, or did it never exist?" is the first question asked after a suspected
leak, and deleting the row makes both cases look identical.

`verification` is the table that grows: it takes a row for every reset link,
every verification link, and every authorization code — so on a busy
deployment, once per sign-in through a client.

---

## Reading the audit log

`/admin/audit`, filterable by event and outcome, newest first. Paged by
timestamp cursor rather than offset, because an offset walk over a table that
only grows at the head repeats and skips rows — in an audit log that is a
missing event in an investigation.

Every row carries the actor, the target, the outcome, the client IP, the user
agent and a **request id** that also appears on the matching log line, so a row
and a log entry can be tied together.

What is recorded (SEC-6): sign-in success and failure, sign-up, verification,
approval and rejection, suspension and its lifting, role changes, password
changes and resets, session revocation, two-factor enrolment and reset, API-key
creation and revocation and failures, impersonation, consent granted and
revoked, token issuance and revocation, client reconciliation diffs, key
rotation, and refused social sign-ins.

Straight from the database when the UI is not enough:

```sql
select created_at, action, outcome, actor_user_id, target_id, ip_address, metadata
from idp.audit_log
where created_at > now() - interval '24 hours'
  and outcome <> 'success'
order by created_at desc;
```

Nothing secret is ever stored: no passwords, no tokens, no reset links.

---

## Somebody is locked out

See the README's [locked out](../README.md#if-you-get-locked-out) section for
the administrator case. For an ordinary user:

- **Forgot their password** — they use `/forgot-password`, or an administrator
  sends a reset from the user's detail page. With e-mail off, set a temporary
  password there instead; it forces a change at their next sign-in.
- **Lost their second factor** — an administrator resets it from the same page.
  That turns 2FA off, signs them out everywhere, and tells them by e-mail. They
  enrol again afterwards.
- **Suspended by mistake** — lift the suspension; the account works again
  immediately.
- **Waiting for approval** — approve them; they get an e-mail and can sign in.

---

## Egress

What the container needs to reach:

| Destination | When | Why |
| --- | --- | --- |
| Postgres | always | Everything |
| `api.resend.com` | e-mail configured | Sending |
| `accounts.google.com`, `github.com`, `login.microsoftonline.com` | that provider enabled | Token exchange during a social sign-in |
| `api.pwnedpasswords.com` | `auth.password.breachCheck` on | The k-anonymity range query; the password never leaves the process |
| its own `server.baseUrl` | always | RP-initiated logout verifies `id_token_hint` against the key set fetched from it |

Nothing else. Fonts and assets are bundled, and the CSP allows no external
origin.

And what must reach **it**: the browser, for sign-in and social callbacks; and
whatever validates the tokens, for `/.well-known/*`. Those two are what a
firewall has to allow, and they can be different networks — the sign-in pages
internal, the key set public.

---

## Health checks

| Endpoint | Answers |
| --- | --- |
| `GET /healthz` | The process is alive. Touches nothing else, so a database blip is not a restart signal. |
| `GET /readyz` | Configuration loaded, database reachable, migrations current, signing key present. `503` until start-up finishes, and again while draining. |

Both are unauthenticated, excluded from rate limiting and kept out of the
request log. Neither reveals anything: no versions of anything but the IdP
itself, no connection strings, no counts.

Point a load balancer at `/readyz`, not `/healthz` — a process that is up but
has not migrated should not receive traffic.

---

## Shutting down

`SIGTERM` — which is what `docker compose stop` sends — stops accepting new
requests, drains for up to `server.shutdownTimeoutSeconds` (10 by default),
closes the pool and exits 0. The compose file sets `stop_grace_period: 30s`, so
Docker does not kill the process in the middle of the thing that exists to
avoid being killed in the middle.

`/readyz` starts answering 503 as soon as draining begins, so a load balancer
takes the instance out before the last requests finish.
