/**
 * Managing gateways from the admin area (FR-GW-7, FR-ADMIN-6, **D91**).
 *
 * `client-admin.test.ts`'s shape, because the rules are the same rules: a row
 * the file owns is refused here, a row added here survives every restart, and
 * every mutation leaves an audit row whoever made it. The difference worth
 * reading is the invalidation — the proxy resolves a name from an in-process
 * map, so an endpoint that wrote a row without clearing it would produce a
 * change that is invisible for up to a minute and an administrator who presses
 * the button again.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createLocalAccountIssuer } from "@better-auth/core/db"
import { eq } from "drizzle-orm"

import { checkGatewayUrl } from "@/lib/gateway-rules"
import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { maskGatewayTarget } from "@/server/config/mask"
import { reconcileGateways } from "@/server/gateways/reconcile"
import {
  gatewayRegistry,
  resetGatewayRegistry,
} from "@/server/gateways/registry"
import type { TestContext } from "./harness"
import { authRequest, createTestContext, sessionCookie } from "./harness"

const PASSWORD = "correct-horse-battery-staple"

let ctx: TestContext

beforeEach(async () => {
  resetGatewayRegistry()
  ctx = await createTestContext("gateway-admin", {
    config: {
      auth: { requireEmailVerification: false },
      gateways: { fromfile: { url: "https://file.example" } },
    },
  })
  await reconcileGateways({
    config: ctx.config,
    database: ctx.database,
    locking: ctx.database,
  })
  resetGatewayRegistry()
})

afterEach(async () => {
  await ctx.teardown()
  resetGatewayRegistry()
})

async function adminCookie(): Promise<string> {
  const context = await ctx.auth.$context
  const user = await createUserWithoutRequest(
    context,
    {
      email: "gateway-admin@example.com",
      name: "Gateway Admin",
      emailVerified: true,
      role: "admin",
      status: "active",
    },
    { method: "admin" }
  )
  await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: user.id,
    password: await context.password.hash(PASSWORD),
  })

  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", {
      json: { email: "gateway-admin@example.com", password: PASSWORD },
    })
  )
  const cookie = sessionCookie(response)
  expect(cookie, "the admin could not sign in").toBeTruthy()
  return cookie!
}

function post(path: string, json: unknown, cookie?: string) {
  return ctx.auth.handler(
    authRequest(path, { json, ...(cookie ? { headers: { cookie } } : {}) })
  )
}

async function gatewayRow(name: string) {
  const [row] = await ctx.database.db
    .select()
    .from(ctx.database.schema.gateway)
    .where(eq(ctx.database.schema.gateway.name, name))
  return row
}

async function auditActions(): Promise<string[]> {
  const rows = await ctx.database.db
    .select({ action: ctx.database.schema.auditLog.action })
    .from(ctx.database.schema.auditLog)
  return rows
    .map((row) => row.action)
    .filter((action) => action.startsWith("gateway."))
}

describe("the gateway admin endpoints", () => {
  it("creates a manual gateway and makes it resolvable at once", async () => {
    const cookie = await adminCookie()
    // Warm the registry first, so the assertion below is about invalidation
    // and not about a map that was empty anyway.
    expect((await gatewayRegistry({ database: ctx.database })).has("added")).toBe(
      false
    )

    const response = await post(
      "/idp/create-gateway",
      { name: "added", url: "https://added.example", requireAuth: true },
      cookie
    )
    expect(response.status).toBe(200)

    const row = await gatewayRow("added")
    expect(row?.source).toBe("manual")
    expect(row?.requireAuth).toBe(true)
    expect(row?.enabled).toBe(true)

    const registry = await gatewayRegistry({ database: ctx.database })
    expect(registry.get("added")?.url).toBe("https://added.example")
    expect(await auditActions()).toContain("gateway.created")
  })

  it("stores trustProxy, and the registry sees it (**D92**)", async () => {
    const cookie = await adminCookie()
    const response = await post(
      "/idp/create-gateway",
      { name: "edge", url: "https://edge.example", trustProxy: true },
      cookie
    )
    expect(response.status).toBe(200)
    expect((await gatewayRow("edge"))?.trustProxy).toBe(true)
    expect(
      (await gatewayRegistry({ database: ctx.database })).get("edge")
        ?.trustProxy
    ).toBe(true)

    // Off by default, and an update is a full replace — so omitting it turns
    // it back off rather than leaving it as it was.
    const updated = await post(
      "/idp/update-gateway",
      { name: "edge", url: "https://edge.example" },
      cookie
    )
    expect(updated.status).toBe(200)
    expect((await gatewayRow("edge"))?.trustProxy).toBe(false)
  })

  /**
   * The round trip `/admin/gateways`'s Edit makes, end to end (**D93**).
   *
   * A bare origin is the *common* target shape — the path is optional — and
   * the list page used to run every row through `maskConnectionString`, which
   * normalizes: `new URL("https://api.example.com").toString()` supplies the
   * empty path. `checkGatewayUrl` answers `trailing_slash` for that, so the
   * edit dialog refused a save that changed nothing but a checkbox, naming a
   * slash the operator never typed. Asserted against the row *and* against the
   * projection the page renders, because the endpoint was never the half that
   * was wrong.
   */
  it("keeps a bare-origin target byte-identical on the way back out", async () => {
    const cookie = await adminCookie()
    const target = "https://api.example.com"
    expect(
      (await post("/idp/create-gateway", { name: "bare", url: target }, cookie))
        .status
    ).toBe(200)

    expect((await gatewayRow("bare"))?.url).toBe(target)
    expect(maskGatewayTarget((await gatewayRow("bare"))!.url)).toEqual({
      url: target,
      masked: false,
    })
    // And the rule the form applies to what it was handed agrees.
    expect(checkGatewayUrl((await gatewayRow("bare"))!.url)).toBeUndefined()
  })

  it("refuses a duplicate name", async () => {
    const cookie = await adminCookie()
    await post(
      "/idp/create-gateway",
      { name: "added", url: "https://added.example" },
      cookie
    )
    const again = await post(
      "/idp/create-gateway",
      { name: "added", url: "https://other.example" },
      cookie
    )
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({
      code: "GATEWAY_ALREADY_EXISTS",
    })
  })

  it("refuses a target the configuration file would refuse", async () => {
    // One definition, two paths: `lib/gateway-rules.ts` is what the zod schema
    // calls, and it is what this endpoint calls. A `file://` target cannot be
    // stored under either name.
    const cookie = await adminCookie()
    for (const url of [
      "file:///etc/passwd",
      "https://api.example/",
      "https://api.example?x=1",
      "https://user:pw@api.example",
      "not-a-url",
    ]) {
      const response = await post(
        "/idp/create-gateway",
        { name: "bad", url },
        cookie
      )
      expect(response.status, url).toBe(400)
      expect(await response.json()).toMatchObject({
        code: "INVALID_GATEWAY_DEFINITION",
      })
    }
  })

  it("refuses a name that is not a usable URL segment", async () => {
    const cookie = await adminCookie()
    for (const name of ["Upper", "has/slash", "..", "has space", ""]) {
      const response = await post(
        "/idp/create-gateway",
        { name, url: "https://api.example" },
        cookie
      )
      expect(response.status, name).toBe(400)
    }
  })

  it("updates, disables and removes a manual gateway", async () => {
    const cookie = await adminCookie()
    await post(
      "/idp/create-gateway",
      { name: "added", url: "https://added.example" },
      cookie
    )

    const updated = await post(
      "/idp/update-gateway",
      { name: "added", url: "https://moved.example", requireAuth: true },
      cookie
    )
    expect(updated.status).toBe(200)
    expect((await gatewayRow("added"))?.url).toBe("https://moved.example")
    expect((await gatewayRow("added"))?.requireAuth).toBe(true)
    expect(
      (await gatewayRegistry({ database: ctx.database })).get("added")?.url
    ).toBe("https://moved.example")

    const disabled = await post(
      "/idp/set-gateway-disabled",
      { name: "added", disabled: true },
      cookie
    )
    expect(disabled.status).toBe(200)
    expect((await gatewayRow("added"))?.enabled).toBe(false)

    const removed = await post(
      "/idp/delete-gateway",
      { name: "added" },
      cookie
    )
    expect(removed.status).toBe(200)
    expect(await gatewayRow("added")).toBeUndefined()
    expect(
      (await gatewayRegistry({ database: ctx.database })).has("added")
    ).toBe(false)

    expect(await auditActions()).toEqual(
      expect.arrayContaining([
        "gateway.created",
        "gateway.updated",
        "gateway.disabled",
        "gateway.deleted",
      ])
    )
  })

  it("refuses every mutation of a config-owned row", async () => {
    // FR-GW-2: an edit here is a change the next restart silently undoes,
    // which is worse than no control at all.
    const cookie = await adminCookie()
    const attempts = [
      ["/idp/update-gateway", { name: "fromfile", url: "https://x.example" }],
      ["/idp/delete-gateway", { name: "fromfile" }],
      ["/idp/set-gateway-disabled", { name: "fromfile", disabled: true }],
    ] as const

    for (const [path, body] of attempts) {
      const response = await post(path, body, cookie)
      expect(response.status, path).toBe(400)
      expect(await response.json()).toMatchObject({
        code: "GATEWAY_MANAGED_BY_FILE",
      })
    }
    expect((await gatewayRow("fromfile"))?.url).toBe("https://file.example")
  })

  it("answers NOT_FOUND for a gateway that does not exist", async () => {
    const cookie = await adminCookie()
    const response = await post(
      "/idp/delete-gateway",
      { name: "nothing" },
      cookie
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: "GATEWAY_NOT_FOUND" })
  })

  it("refuses a caller who is not an administrator", async () => {
    // FR-ADMIN-6 makes these a documented API, so the gate has to be on the
    // endpoint rather than on the page in front of it.
    const response = await post("/idp/create-gateway", {
      name: "added",
      url: "https://added.example",
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await gatewayRow("added")).toBeUndefined()
  })
})
