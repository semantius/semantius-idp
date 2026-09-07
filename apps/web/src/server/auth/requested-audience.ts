/**
 * The audience one in-process mint should put in the JWT.
 *
 * `GET {authBaseUrl}/token` takes no parameters: Better Auth's JWT plugin
 * builds the payload from `definePayload(session)` and signs it with
 * `options.jwt.audience` unless the payload names an `aud` of its own
 * (`plugins/jwt/sign.ts`: `setAudience(aud ?? defaultAud)`). So a gateway
 * that wants its upstream's identifier as the audience has exactly one way
 * to say so — through the payload — and `definePayload` sees the session and
 * nothing else. There is no request to read a header from that the payload
 * builder can reach.
 *
 * An `AsyncLocalStorage` scope is the narrowest bridge: the gateway proxy
 * wraps its synthetic `/token` call in {@link withRequestedAudience}, and
 * `sessionTokenPayload` (`auth/instance.ts`) reads {@link requestedAudience}
 * while building the claims. Outside such a scope — the ordinary `/token`
 * call a script makes, every OAuth grant, the CLI — it is `undefined` and
 * the payload carries no `aud`, so the plugin's default (`jwt.audience`,
 * the default audience) applies byte for byte as before.
 *
 * Its own module rather than a field on `http/request-log.ts`'s request
 * context, because that context is created once per inbound request by
 * `server-entry.ts` and this value is per *mint* — one inbound request may
 * mint for one gateway now and be answered from the cache for another later,
 * and a value left on the request context would outlive the call it was
 * meant for.
 */

import { AsyncLocalStorage } from "node:async_hooks"

const storage = new AsyncLocalStorage<string>()

/** Runs `fn` with `audience` as the `aud` every mint inside it requests. */
export function withRequestedAudience<T>(audience: string, fn: () => T): T {
  return storage.run(audience, fn)
}

/**
 * The audience the current mint was asked for, or `undefined` when nothing
 * asked — which is every path except a gateway with a `audience`.
 */
export function requestedAudience(): string | undefined {
  return storage.getStore()
}
