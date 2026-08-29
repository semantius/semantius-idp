# The admin API

Everything the administration pages do is an HTTP call, and every one of those
calls is available to you. This is what "pluggable user management" means here:
there is no separate management API to keep in step with the UI, because the UI
uses this one.

## Authenticating

Two ways, and they are equivalent:

**A session cookie** — whatever your browser already has after signing in as an
administrator. Useful from the browser console, and what the pages themselves
use.

**An API key belonging to an administrator** — which is what a script wants:

```bash
curl -H "x-api-key: $IDP_API_KEY" \
     https://idp.example.com/api/auth/admin/list-users
```

A key authenticates **as its owner**, with their roles. It opens the admin API
only if that person holds a role in `admin.adminRoles`, and their standing is
re-checked on every request — suspend them and the key stops working
immediately.

Everything lives under `{baseUrl}/api/auth/`. A non-administrator gets 403 from
every endpoint below; an anonymous caller gets 401.

## Users

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/admin/create-user` | Creates an account, pre-approved and confirmed |
| `GET` | `/admin/list-users` | Searches, filters, sorts and pages |
| `POST` | `/admin/update-user` | Name, address, verified flag |
| `POST` | `/admin/set-role` | Replaces the user's roles |
| `POST` | `/admin/set-user-password` | Sets a password |
| `POST` | `/admin/ban-user` | Suspends, with a reason and optional expiry |
| `POST` | `/admin/unban-user` | Lifts a suspension |
| `POST` | `/admin/remove-user` | Deletes the account and everything attached |
| `POST` | `/admin/revoke-user-sessions` | Signs them out everywhere |
| `POST` | `/admin/impersonate-user` | Only when `admin.allowImpersonation` is on |

Creating a user:

```bash
curl -X POST https://idp.example.com/api/auth/admin/create-user \
  -H "x-api-key: $IDP_API_KEY" \
  -H "content-type: application/json" \
  -d '{
        "email": "ada@example.com",
        "name": "Ada Lovelace",
        "password": "…",
        "role": ["user"],
        "data": { "status": "active", "emailVerified": true }
      }'
```

`data.status` and `data.emailVerified` are what make it a *vouched* account
rather than one in the approval queue — it is you doing the vouching. Leave
them out and it lands as `pending` like a self-registration.

To have the person choose their own password, create the account and then send
a reset:

```bash
curl -X POST https://idp.example.com/api/auth/request-password-reset \
  -H "content-type: application/json" \
  -d '{"email": "ada@example.com", "redirectTo": "/reset-password"}'
```

## Approval

The queue is this deployment's own, so these two are not Better Auth
endpoints:

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/idp/approve-user` | `pending` → `active`, and tells them by e-mail |
| `POST` | `/idp/reject-user` | `pending` → `rejected`, optionally telling them |

```bash
curl -X POST https://idp.example.com/api/auth/idp/approve-user \
  -H "x-api-key: $IDP_API_KEY" \
  -H "content-type: application/json" \
  -d '{"userId": "Kx7mQ2vR9pL4nW8sT1yZbH3gJ6dF0aCe"}'
```

Rejecting takes `{"userId": "…", "notify": true}`. Approval does **not** resume
whatever authorization request the person abandoned — the e-mail sends them to
the sign-in page and they start again from the application.

## The database console

Two endpoints, and **only when `admin.database` is not `disabled`** (FR-ADMIN-7,
**D83**). With the flag off they are not registered at all, so an administrator
calling them gets a plain `404` — the feature is absent, not refused.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/idp/database/schema` | Tables, columns, indexes and foreign keys of `database.schema`, plus the deployment's own mode |
| `POST` | `/idp/database/query` | Runs **one** statement and returns its rows |

```bash
curl -s -X POST https://idp.example.com/api/auth/idp/database/query \
     -H "x-api-key: $IDP_API_KEY" \
     -H "content-type: application/json" \
     -d '{"query": "select id, email from \"user\" order by \"created_at\" desc limit 5"}'
```

`mode` is `read` unless you say otherwise. `read` opens a **READ ONLY
transaction**, so a write is refused by Postgres — `400` with
`"sqlstate": "25006"` — however it is disguised; a writable CTE fails the same
way. `mode: "read-write"` is only accepted by a deployment configured
`read-write`, and anything else answers `400 WRITE_NOT_ALLOWED`.

**One statement per call.** The query goes over the extended protocol, which
refuses a multi-command string with `400` and `"sqlstate": "42601"` before
running any of it — so `COMMIT; delete from …` is a syntax error rather than a
way out of the transaction.

The other limits: 10 s per statement (`57014` on a timeout), 500 rows,
~10 kB per cell and ~5 MB per response, with `"truncated": true` when any of
them bit. Every call is audited as `database.queried`, success or not.

A failure is a `400` carrying everything the editor needs to point at it:

```json
{
  "code": "QUERY_FAILED",
  "message": "relation \"users\" does not exist",
  "sqlstate": "42P01",
  "line": 1,
  "column": 15
}
```

**This reads everything.** An admin API key that can call this endpoint can
select password hashes, session tokens and the JWKS rows. That is what the
console is for; leave `admin.database` at `disabled` if it is not what you
want.

## The rest

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/idp/reset-two-factor` | Turns 2FA off, signs them out, tells them |
| `GET` | `/idp/admin-stats` | The dashboard counts |
| `GET` | `/idp/audit` | The audit trail, filterable and cursor-paged |
| `GET` | `/idp/system` | Version, issuer, the well-known **discovery URLs** (**D55**), e-mail transport, keys, migrations, last reconcile, effective configuration with secrets masked |
| `POST` | `/idp/rotate-keys` | Creates a successor signing key |
| `POST` | `/idp/create-client` | Registers an OAuth client (**D50**) |
| `POST` | `/idp/update-client` | Replaces one's fields, except its id (**D72**) |
| `POST` | `/idp/rotate-client-secret` | Issues a new secret and returns it once (**D72**) |
| `POST` | `/idp/set-client-disabled` | Switches one off, or back on |
| `POST` | `/idp/delete-client` | Removes one, with its tokens and consents |
| `POST` | `/idp/create-gateway` | Adds an API gateway (**D91**) |
| `POST` | `/idp/update-gateway` | Replaces its target and auth rule, not its name |
| `POST` | `/idp/set-gateway-disabled` | Switches one off, or back on |
| `POST` | `/idp/delete-gateway` | Removes one |

The role catalog is **read-only** over HTTP: it comes from `roles.jsonc`, and
`GET /admin/roles` shows what was reconciled along with any warnings.

`skipConsent` and `enableEndSession` are worth sending explicitly. Both are
optional, and both default to `true` in the client schema — but the endpoint
passes through whatever you send, so a *defined* `false` wins over the default.
`enableEndSession: true` is refused unless the client also has at least one
`postLogoutRedirectUris` entry.

Clients are **half** read-only (**D50**). The ones in `oauth_clients.jsonc` are
reconciled at start-up and refused by the five endpoints above with
`CLIENT_MANAGED_BY_FILE`, because a change here is a change the next restart
would silently undo. Clients registered *through* the API are stored with the
calling administrator as their owner — which is the marker reconciliation's
sweep skips — so they survive restarts and can be edited, rotated, disabled
and removed.

```bash
curl -X POST https://idp.example.com/api/auth/idp/create-client   -H "x-api-key: $IDP_API_KEY"   -H "content-type: application/json"   -d '{
        "clientId": "reporting",
        "name": "Reporting",
        "type": "web",
        "redirectUris": ["https://reporting.example.com/callback"],
        "scopes": ["openid", "profile", "email"],
        "skipConsent": true,
        "enableEndSession": false
      }'
```

The entry is validated by the **same schema `oauth_clients.jsonc` is**, so a
wildcard redirect or plain http off loopback is refused here too. The secret is
generated by the server and returned **once**, in the response — the row keeps
a hash — and only for `type: "web"`; `spa` and `native` are public clients and
get none. `enableEndSession` defaults to true and then requires at least one
`postLogoutRedirectUris` entry.

A created client works immediately: nothing needs a restart, and the CORS and
`form-action` origin sets are refreshed before the call returns.

### Editing one (**D72**)

`/idp/update-client` takes the **same body as `create`** and is a **full
replace**: whatever you send is what the client becomes, so read the row first
and send it back with your changes rather than sending only the field you want
to change. Five things it does not take from the body:

- **the client id**, which is the natural key `token`, `oauth_consent`,
  `oauth_client_resource` and the audit trail all reference — changing it is
  removing this client and adding a different one;
- **the owner**, which is preserved from the existing row, because a null owner
  is the file marker and the next reconcile would disable the client;
- **`disabled`**, likewise preserved — an edit must not switch a suspended
  client back on;
- **`createdAt`**, untouched;
- **the secret**, whose disposition follows the type. Staying confidential
  keeps the existing secret working, byte for byte. `spa`/`native` → `web`
  mints one and returns it **once**, in `clientSecret`, exactly as a creation
  does. `web` → `spa`/`native` discards it.

The whole merged entry is re-validated against the `oauth_clients.jsonc`
schema, so a type change re-checks the stored redirect URIs — a private-use
scheme is legal for `native` and refused for `web`. Tokens and consents are
revoked **only when the public/confidential flip happens**: a renamed client or
an edited redirect URI revokes nothing, matching what reconciliation does for
an edited file entry. The origin sets are refreshed before the call returns.

### Rotating a secret (**D72**)

```bash
curl -X POST https://idp.example.com/api/auth/idp/rotate-client-secret \
     -H "x-api-key: $IDP_API_KEY" \
     -H "content-type: application/json" \
     -d '{"clientId": "reporting"}'
```

The new secret is in the response and nowhere else. **There is no grace
window**: the previous secret stops authenticating the moment this returns, so
deploy the new one to the application before rotating, or expect a gap.
Rotation is hygiene — it revokes **nothing**, because the client is still the
same client. If you believe a secret is compromised, disable or remove the
client instead; both of those do revoke. A public client (`spa`, `native`) has
no secret and is refused with `CLIENT_HAS_NO_SECRET` rather than quietly given
one — that is an edit, and `/idp/update-client` is where an edit belongs.

## API gateways (**D91**)

A gateway is a named reverse proxy: `/gateway/<name>[/<rest>]` is streamed to
`<url>/<rest>` with the caller's method, headers, query and body unchanged. A
caller that sends `x-api-key` and no `Authorization` has the key exchanged for
a session JWT — the same exchange `GET /api/auth/token` performs, with the same
ban re-check and the same `azp` — and the JWT is injected as
`Authorization: Bearer`. That is what lets a client holding only an API key
reach a resource server which validates this issuer's JWTs and knows nothing
about API keys.

```bash
curl -X POST https://idp.example.com/api/auth/idp/create-gateway \
     -H "x-api-key: $IDP_API_KEY" \
     -H "content-type: application/json" \
     -d '{"name": "data", "url": "https://postgrest.internal:3000"}'
```

Then `curl -H "x-api-key: $USER_KEY" https://idp.example.com/gateway/data/items`.

`requireAuth: true` refuses a call carrying no credential at all instead of
forwarding it anonymously — leave it off for a target with an anonymous role of
its own, like PostgREST. `trustProxy: true` forwards the `X-Forwarded-*` a
reverse proxy in front of this IdP set, rather than replacing them with what
this hop can see (**D92**); only set it when something in front actually sets
them.

Gateways are **half** read-only, the way clients are. The ones in the
`gateways` block of `config.jsonc` are reconciled at start-up and refused by
the four endpoints above with `GATEWAY_MANAGED_BY_FILE`; the ones added
through the API are stored with `source: "manual"`, which is the value the
start-up sweep skips, so they survive restarts and can be edited, disabled and
removed.

**The exchange is cached for ten minutes**, and a cache hit skips the owner
re-check. A ban, a key revocation or a sign-out made through *this* API clears
the cache immediately; one made outside the process — `psql`, another replica —
takes up to the ten minutes. That is the documented trade-off, not a bug.

## The refusals

Some things are refused however you ask, because they are the ones that lock a
deployment out of itself:

| Code | Means |
| --- | --- |
| `LAST_ADMIN_PROTECTED` | This is the only administrator left. Give another account an admin role first. |
| `ADMIN_CANNOT_CHANGE_OWN_ROLES` | Ask another administrator. |
| `ADMIN_CANNOT_BAN_SELF` | — |
| `ADMIN_CANNOT_DELETE_SELF` | — |
| `ONLY_ADMINS_GRANT_ADMIN_ROLES` | — |
| `IMPERSONATION_DISABLED` | `admin.allowImpersonation` is off, which is the default. |
| `CLIENT_MANAGED_BY_FILE` | That client comes from `oauth_clients.jsonc`. Edit the file and restart. |
| `CLIENT_ALREADY_EXISTS` | A client with that id is already registered. |
| `INVALID_CLIENT_DEFINITION` | The entry does not satisfy the `oauth_clients.jsonc` schema; the message names what. |
| `SCOPE_NOT_ALLOWED` | A scope outside `oauth.scopes`. |
| `CLIENT_HAS_NO_SECRET` | A public client has nothing to rotate. Change its type first. |
| `GATEWAY_MANAGED_BY_FILE` | That gateway comes from `config.jsonc`. Edit the file and restart. |
| `GATEWAY_ALREADY_EXISTS` | A gateway with that name already exists. |
| `GATEWAY_NOT_FOUND` | No gateway by that name. |
| `INVALID_GATEWAY_DEFINITION` | The name is not a usable URL segment, or the target is not an absolute http(s) URL without a trailing slash, query, fragment or userinfo; the message names which. |

The last-administrator rule is checked **before** the self-action rules. When
both fit, "give another account an admin role first" is the useful answer:
with two administrators the last-admin rule never applies, so that message only
ever reaches the one person who has nobody to ask.

If every administrator is somehow locked out anyway, see
[locked out](../README.md#if-you-get-locked-out) — there is no
`reset-admin` command any more (**D52**), and the recoveries are another
administrator, the password-reset e-mail, or the SQL promotion in
[runbooks](runbooks.md#promoting-a-user-when-nobody-can-sign-in).

## Everything is audited

Every call here writes an audit row with the actor, the target, the outcome and
a request id that also appears on the log line. An API key does not make an
action anonymous: the row names the key's owner, and `actorType` says the call
came from a key rather than a browser.

Read them back through `GET /idp/audit`, or at `/admin/audit`.
