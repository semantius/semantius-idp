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
| `GET` | `/idp/system` | Version, issuer, e-mail transport, keys, migrations, last reconcile, effective configuration with secrets masked |
| `POST` | `/idp/rotate-keys` | Creates a successor signing key |

Clients and the role catalog are **read-only** over HTTP: they come from
`oauth_clients.json` and `roles.json`, and the endpoints that would create or
edit them are unreachable by design. `GET /admin/clients` and
`GET /admin/roles` show what was reconciled, along with the last reconcile time
and any warnings.

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

The last-administrator rule is checked **before** the self-action rules. When
both fit, "give another account an admin role first" is the useful answer:
with two administrators the last-admin rule never applies, so that message only
ever reaches the one person who has nobody to ask.

If every administrator is somehow locked out anyway, the way back is
`idp reset-admin` — see the [README](../README.md#if-you-get-locked-out).

## Everything is audited

Every call here writes an audit row with the actor, the target, the outcome and
a request id that also appears on the log line. An API key does not make an
action anonymous: the row names the key's owner, and `actorType` says the call
came from a key rather than a browser.

Read them back through `GET /idp/audit`, or at `/admin/audit`.
