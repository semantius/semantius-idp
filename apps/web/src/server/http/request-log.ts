/**
 * One structured line per request, and the id that ties it to the audit trail
 * (SEC-5, SEC-6).
 *
 * The `audit_log` table has carried a `request_id` column since M4 and nothing
 * has ever filled it in, because nothing generated one. That is what this
 * module is for: an id is minted at the edge, put where the audit writer can
 * find it for the duration of the request, and printed on the log line — so an
 * event in the trail and a line in the log can be put side by side afterwards.
 * Without it, "the ban at 14:02" and "the 403 at 14:02" are two facts nobody
 * can join.
 *
 * **What is never logged** (SEC-5): passwords, tokens, authorization codes,
 * secrets, reset and verification links, `Authorization` and `Cookie` headers,
 * and the *query string* of `/oauth2/*` and `/api/auth/*` — which is where the
 * authorization code, the signed continuation and the reset token all travel.
 * `safeUrlForLog` does that trimming and is shared with the logger.
 *
 * `/healthz` and `/readyz` are excluded. A container health check runs every
 * few seconds forever, and a log full of its own heartbeat is a log nobody
 * reads.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"

import { anonymizeIp, safeUrlForLog } from "../logger"
import type { Logger } from "../logger"

/** Paths that produce no log line, matched after the mount path is stripped. */
const QUIET_PATHS = new Set(["/healthz", "/readyz"])

export interface RequestContext {
  requestId: string
  /** Already anonymised (SEC-5): the last octet or the low 64 bits are gone. */
  ipAddress?: string
  /**
   * The HTTP status the rendered **document** should carry, when it is not
   * 200 (FR-ROLE-3).
   *
   * TanStack Start's `setResponseStatus` does not reach an SSR page: the
   * document response is built by `renderRouterToStream` with
   * `status: router.stores.statusCode.get()`, which the router sets to 404 for
   * a `notFound()`, 500 for an errored match, and 200 otherwise. There is no
   * supported way for a loader to ask for a third value, and the admin
   * refusal needs one — FR-ROLE-3 says 403 and the page rendered with 200, so
   * every proxy, log and probe recorded a successful page view of the admin
   * area by somebody who cannot see it.
   *
   * So the loader leaves the status here and `server-entry.ts` applies it to
   * the response on the way out. Request-scoped because this store is, which
   * is what keeps two concurrent requests from stamping each other.
   */
  documentStatus?: number
}

const storage = new AsyncLocalStorage<RequestContext>()

/**
 * The current request's context, if there is one.
 *
 * Returns `undefined` outside a request — during start-up, in the CLI, in a
 * background job — and every caller treats that as ordinary rather than as an
 * error, because those are all real ways for this code to run.
 */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore()
}

/** The current request id, for an audit row. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId
}

/**
 * Asks for a non-200 status on the rendered document (**FR-ROLE-3**).
 *
 * A no-op outside a request, like everything else here. Only widening is
 * allowed: the first caller to ask for an error status wins, so a nested
 * refusal cannot be masked by a later, milder one.
 */
export function setDocumentStatus(status: number): void {
  const context = storage.getStore()
  if (!context) return
  if (context.documentStatus === undefined) context.documentStatus = status
}

/** Runs `fn` with a request context in scope. */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

/**
 * A fresh id.
 *
 * Sixteen hex characters: long enough that two requests in a day will not
 * collide, short enough to be read out over a phone call, which is what a
 * support conversation about one actually looks like.
 */
export function newRequestId(): string {
  return randomBytes(8).toString("hex")
}

/**
 * An id supplied by a trusted proxy, or a new one.
 *
 * Only honoured when the deployment trusts its proxy at all — an id is echoed
 * into logs, so accepting an arbitrary one from the internet is a way to write
 * whatever you like into them. Constrained to a short alphanumeric shape for
 * the same reason.
 */
export function requestIdFrom(
  request: Request,
  trustProxy: boolean | readonly string[]
): string {
  if (trustProxy === false) return newRequestId()
  const supplied = request.headers.get("x-request-id")
  if (supplied && /^[A-Za-z0-9._-]{1,64}$/.test(supplied)) return supplied
  return newRequestId()
}

export interface RequestLogEntry {
  requestId: string
  method: string
  path: string
  status: number
  durationMs: number
  ipAddress?: string
}

/** Whether this path is one of the ones that logs nothing. */
export function isQuietPath(pathname: string, basePath = ""): boolean {
  const relative =
    basePath !== "" && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length)
      : pathname
  return QUIET_PATHS.has(relative)
}

/**
 * Builds the entry for one completed request.
 *
 * The path goes through `safeUrlForLog`, which drops the query string for
 * `/oauth2/*` and `/api/auth/*` wholesale rather than trying to name the
 * parameters that are sensitive — the list of those grows every time a plugin
 * is added, and a redaction list that has to be maintained is one that will be
 * wrong.
 */
export function buildLogEntry({
  request,
  status,
  startedAt,
  requestId,
  ipAddress,
  now = Date.now(),
}: {
  request: Request
  status: number
  startedAt: number
  requestId: string
  ipAddress?: string
  now?: number
}): RequestLogEntry {
  const url = new URL(request.url)
  return {
    requestId,
    method: request.method,
    path: safeUrlForLog(`${url.pathname}${url.search}`),
    status,
    durationMs: Math.max(0, Math.round(now - startedAt)),
    ...(ipAddress ? { ipAddress: anonymizeIp(ipAddress) } : {}),
  }
}

/**
 * Writes the entry at the level its status deserves.
 *
 * A 5xx is ours to explain, so it goes to `error`. A 4xx is usually the
 * caller's — a wrong password, an expired link — and putting those at `warn`
 * would fill the log with other people's mistakes and bury ours.
 */
export function logRequest(logger: Logger, entry: RequestLogEntry): void {
  if (entry.status >= 500) logger.error("request", { ...entry })
  else logger.info("request", { ...entry })
}
