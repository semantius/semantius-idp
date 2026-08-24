/**
 * What the consent screen renders from (FR-OIDC-9).
 *
 * The provider hands the whole authorization request to the page as a signed
 * query string. Reading `client_id` and `scope` out of it is enough to decide
 * what to *show*; the display details — name, icon, terms, privacy policy —
 * come from `oauth_clients.json`, which is the source of truth for clients
 * (FR-OIDC-2) and saves a database read on a page that is already on the
 * critical path of every first authorization.
 *
 * **This does not verify the signature, and must not pretend to.** The
 * provider verifies it when the decision is posted back. A tampered request
 * therefore produces a consent screen naming whatever it names and then fails
 * at `POST /oauth2/consent` — which is the right place for it to fail, because
 * that is the only place that can fail it *safely*, without having redirected
 * anywhere first.
 */

import { createServerFn } from "@tanstack/react-start"

import { getRuntime } from "../runtime"

export interface ConsentRequestView {
  clientId: string
  clientName: string
  clientUri?: string
  icon?: string
  tos?: string
  policy?: string
  /** The scopes actually being asked for, in the order the client asked. */
  scopes: string[]
  /** Handed straight back to the provider, unread and unmodified. */
  oauthQuery: string
}

export const fetchConsentRequest = createServerFn({ method: "GET" })
  .inputValidator((query: unknown) => (typeof query === "string" ? query : ""))
  .handler(async ({ data: query }): Promise<ConsentRequestView | null> => {
    if (query === "") return null
    const runtime = await getRuntime()

    const params = new URLSearchParams(
      query.startsWith("?") ? query.slice(1) : query
    )
    const clientId = params.get("client_id")
    if (!clientId) return null

    const client = runtime.config.clients.find(
      (entry) => entry.clientId === clientId
    )

    const requested = (params.get("scope") ?? "")
      .split(/\s+/)
      .filter((scope) => scope !== "")

    return {
      clientId,
      // The id is a poor label but an honest one: a client that is not in the
      // file is one the provider will refuse anyway.
      clientName: client?.name ?? clientId,
      clientUri: client?.uri,
      icon: client?.icon,
      tos: client?.tos,
      policy: client?.policy,
      scopes: requested,
      oauthQuery: params.toString(),
    }
  })
