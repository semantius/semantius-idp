/**
 * What `/device` renders from: who is signed in, and what the code they typed
 * is asking for.
 *
 * **Looking a code up claims it.** The plugin's `GET /device` binds a pending
 * code to the first signed-in user who asks about it, and only that user can
 * then approve or deny it — which is what stops a code shown on one person's
 * screen from being approved from somebody else's session. So the lookup is
 * only ever made with a session, and it goes through the plugin rather than a
 * read of the table: the claim is the plugin's to make, atomically, and a
 * second copy of that rule here would be the one that drifts.
 *
 * The lookup is also the guessable surface. The plugin limits it to five per
 * address per code lifetime, and the request carries the caller's own headers
 * — the address header the edge resolved included — so that limit is the
 * caller's and not the whole deployment's.
 */

import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { eq } from "drizzle-orm"

import { readSession } from "../http/session"
import { createBasePaths } from "../oidc/base-path"
import { getRuntime } from "../runtime"
import type { Runtime } from "../runtime"

/** Why a code cannot be approved, as a code the page turns into a sentence. */
export type DeviceRefusal =
  | "invalid"
  | "expired"
  | "used"
  | "otherAccount"
  | "tooMany"

export interface DeviceRequestView {
  /** As the user typed it: echoed back in the approval form, never trusted. */
  userCode: string
  clientId: string
  clientName: string
  clientUri?: string
  /** The scopes asked for, in the order the client asked. */
  scopes: string[]
}

export type DeviceLookup =
  | { state: "signedOut" }
  | { state: "forcedChange" }
  /** Signed in, and no code yet. */
  | { state: "entry" }
  | { state: "refused"; reason: DeviceRefusal; userCode: string }
  | { state: "confirm"; email: string; request: DeviceRequestView }

export const fetchDeviceRequest = createServerFn({ method: "GET" })
  .validator((code: unknown) => (typeof code === "string" ? code.trim() : ""))
  .handler(async ({ data: userCode }): Promise<DeviceLookup> => {
    const runtime = await getRuntime()
    const request = getRequest()

    // The row, not the cookie cache: this read is what decides whether a
    // code gets claimed, and a session suspended a minute ago must not.
    const session = await readSession(runtime, request, {
      authoritative: true,
    })
    if (!session) return { state: "signedOut" }
    if (session.user.mustChangePassword) return { state: "forcedChange" }
    if (userCode === "") return { state: "entry" }

    const answer = await lookUp(runtime, request, userCode)
    if ("reason" in answer) {
      return { state: "refused", reason: answer.reason, userCode }
    }

    const client = await clientDisplay(runtime, answer.clientId)
    return {
      state: "confirm",
      email: session.user.email,
      request: {
        userCode,
        clientId: answer.clientId,
        clientName: client?.name ?? answer.clientId,
        ...(client?.uri ? { clientUri: client.uri } : {}),
        scopes: answer.scopes,
      },
    }
  })

async function lookUp(
  runtime: Runtime,
  request: Request,
  userCode: string
): Promise<{ clientId: string; scopes: string[] } | { reason: DeviceRefusal }> {
  const paths = createBasePaths(runtime.config.base)
  const query = new URLSearchParams({ user_code: userCode })
  const response = await runtime.auth.handler(
    new Request(`${paths.authBaseUrl}/device?${query.toString()}`, {
      method: "GET",
      headers: request.headers,
    })
  )
  if (response.status === 429) return { reason: "tooMany" }

  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown
    status?: unknown
    client_id?: unknown
    scope?: unknown
  }
  if (!response.ok) {
    return { reason: body.error === "expired_token" ? "expired" : "invalid" }
  }
  if (body.status !== "pending") return { reason: "used" }
  // The plugin names the client only to the user the code is bound to. A
  // pending code with no client in the answer was claimed by somebody else
  // first — the one case where carrying on would be approving a stranger's
  // request, or having ours approved by one.
  if (typeof body.client_id !== "string") return { reason: "otherAccount" }

  return {
    clientId: body.client_id,
    scopes:
      typeof body.scope === "string"
        ? body.scope.split(/\s+/).filter((scope) => scope !== "")
        : [],
  }
}

/**
 * The client's display details, from the row rather than the file: a client
 * registered from `/admin/clients` can hold the grant too, and it is in the
 * table only.
 */
async function clientDisplay(
  runtime: Runtime,
  clientId: string
): Promise<{ name: string; uri?: string } | undefined> {
  const { oauthClient } = runtime.database.schema
  const [row] = await runtime.database.db
    .select({ name: oauthClient.name, uri: oauthClient.uri })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1)
  if (!row) return undefined
  return {
    name: row.name ?? clientId,
    ...(row.uri ? { uri: row.uri } : {}),
  }
}
