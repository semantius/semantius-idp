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

## The rest

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/idp/reset-two-factor` | Turns 2FA off, signs them out, tells them |
| `GET` | `/idp/admin-stats` | The dashboard counts |
| `GET` | `/idp/audit` | The audit trail, filterable and cursor-paged |
| `GET` | `/idp/system` | Version, issuer, the well-known **discovery URLs** (**D55**), e-mail transport, keys, migrations, last reconcile, effective configuration with secrets masked |
| `POST` | `/idp/rotate-keys` | Creates a successor signing key |
| `POST` | `/idp/create-client` | Registers an OAuth client (**D50**) |
| `POST` | `/idp/set-client-disabled` | Switches one off, or back on |
| `POST` | `/idp/delete-client` | Removes one, with its tokens and consents |

The role catalog is **read-only** over HTTP: it comes from `roles.jsonc`, and
`GET /admin/roles` shows what was reconciled along with any warnings.

`skipConsent` and `enableEndSession` are worth sending explicitly. Both are
optional, and both default to `true` in the client schema — but the endpoint
passes through whatever you send, so a *defined* `false` wins over the default.
`enableEndSession: true` is refused unless the client also has at least one
`postLogoutRedirectUris` entry.

Clients are **half** read-only (**D50**). The ones in `oauth_clients.jsonc` are
reconciled at start-up and refused by the three endpoints above with
`CLIENT_MANAGED_BY_FILE`, because a change here is a change the next restart
would silently undo. Clients registered *through* the API are stored with the
calling administrator as their owner — which is the marker reconciliation's
sweep skips — so they survive restarts and can be disabled and removed.

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
