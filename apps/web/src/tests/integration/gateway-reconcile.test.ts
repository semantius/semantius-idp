/**
 * Gateway reconciliation against a real database (FR-GW-2, **D91**).
 *
 * The shape is `reconcile.test.ts`'s, because the rules are the same rules:
 * the file is the source of truth, absence is a decision, and the sweep must
 * not touch a row an administrator added. The one thing that is genuinely
 * different is the marker — `source`, an explicit column rather than the
 * clients' `userId === null` — so the "manual rows survive" case is the one
 * worth reading first.
 */

import { afterEach, describe, expect, it } from "vitest"

import { eq } from "drizzle-orm"

import { reconcileGateways } from "@/server/gateways/reconcile"
import { resetGatewayRegistry } from "@/server/gateways/registry"
import type { TestContext } from "./harness"
import { createTestContext } from "./harness"

let ctx: TestContext | undefined

afterEach(async () => {
  await ctx?.teardown()
  ctx = undefined
  resetGatewayRegistry()
})

async function contextWith(
  label: string,
  gateways: Record<string, unknown>,
  config: Record<string, unknown> = {}
): Promise<TestContext> {
  ctx = await createTestContext(label, { config: { gateways, ...config } })
  return ctx
}

/** Reconciles using the context's own connection for both handles. */
async function reconcile(context: TestContext) {
  return reconcileGateways({
    config: context.config,
    database: context.database,
    locking: context.database,
  })
}

async function gatewayRow(context: TestContext, name: string) {
  const [found] = await context.database.db
    .select()
    .from(context.database.schema.gateway)
    .where(eq(context.database.schema.gateway.name, name))
  return found
}

async function insertManual(
  context: TestContext,
  name: string,
  url = "https://manual.example"
) {
  await context.database.db.insert(context.database.schema.gateway).values({
    id: crypto.randomUUID(),
    name,
    url,
    requireAuth: false,
    source: "manual",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

describe("gateway reconciliation", () => {
  it("creates the rows the file describes", async () => {
    const context = await contextWith("gw_reconcile_create", {
      data: { url: "https://postgrest.example" },
      internal: { url: "https://api.example", requireAuth: true },
    })

    const diff = await reconcile(context)
    expect(diff.created.sort()).toEqual(["data", "internal"])
    expect(diff.unchanged).toBe(false)

    const data = await gatewayRow(context, "data")
    expect(data?.url).toBe("https://postgrest.example")
    expect(data?.source).toBe("config")
    expect(data?.enabled).toBe(true)
    expect(data?.requireAuth).toBe(false)
    expect((await gatewayRow(context, "internal"))?.requireAuth).toBe(true)
  })

  it("writes nothing on an unchanged re-run", async () => {
    // The property that keeps the audit trail meaningful: a restart that
    // changed nothing must not report that it did.
    const context = await contextWith("gw_reconcile_idempotent", {
      data: { url: "https://postgrest.example" },
    })
    await reconcile(context)
    const before = await gatewayRow(context, "data")

    const second = await reconcile(context)
    expect(second.unchanged).toBe(true)
    expect((await gatewayRow(context, "data"))?.updatedAt).toEqual(
      before?.updatedAt
    )
  })

  it("updates a target that changed in the file", async () => {
    const context = await contextWith("gw_reconcile_update", {
      data: { url: "https://old.example" },
    })
    await reconcile(context)

    // The file is the source of truth, so the next boot's value wins.
    const moved = await createTestContext("gw_reconcile_update_2", {
      config: { gateways: { data: { url: "https://new.example" } } },
      // Same schema is not available across contexts, so this asserts the
      // update through a direct row edit instead: write the old value, then
      // reconcile the new config over it.
    })
    try {
      await moved.database.db.insert(moved.database.schema.gateway).values({
        id: crypto.randomUUID(),
        name: "data",
        url: "https://old.example",
        requireAuth: false,
        source: "config",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      const diff = await reconcile(moved)
      expect(diff.updated).toEqual(["data"])
      expect((await gatewayRow(moved, "data"))?.url).toBe(
        "https://new.example"
      )
    } finally {
      await moved.teardown()
    }
  })

  it("re-enables a config gateway an administrator switched off", async () => {
    // File-owned end to end (**D91**): a config gateway is switched off by
    // removing it from the file, not by a toggle the next restart would
    // silently reverse.
    const context = await contextWith("gw_reconcile_reenable", {
      data: { url: "https://postgrest.example" },
    })
    await reconcile(context)
    await context.database.db
      .update(context.database.schema.gateway)
      .set({ enabled: false })
      .where(eq(context.database.schema.gateway.name, "data"))

    const diff = await reconcile(context)
    expect(diff.updated).toEqual(["data"])
    expect((await gatewayRow(context, "data"))?.enabled).toBe(true)
  })

  it("disables a gateway that has left the file, and prunes it when asked", async () => {
    const context = await contextWith("gw_reconcile_orphan", {})
    await context.database.db.insert(context.database.schema.gateway).values({
      id: crypto.randomUUID(),
      name: "gone",
      url: "https://gone.example",
      requireAuth: false,
      source: "config",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const disabled = await reconcile(context)
    expect(disabled.disabled).toEqual(["gone"])
    expect((await gatewayRow(context, "gone"))?.enabled).toBe(false)

    // Already disabled: not a change, so a boot that finds it this way writes
    // nothing and reports nothing.
    expect((await reconcile(context)).unchanged).toBe(true)

    const pruning = await createTestContext("gw_reconcile_prune", {
      config: { gateways: {}, oauth: { reconcile: { prune: true } } },
    })
    try {
      await pruning.database.db.insert(pruning.database.schema.gateway).values({
        id: crypto.randomUUID(),
        name: "gone",
        url: "https://gone.example",
        requireAuth: false,
        source: "config",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      const diff = await reconcile(pruning)
      expect(diff.deleted).toEqual(["gone"])
      expect(await gatewayRow(pruning, "gone")).toBeUndefined()
    } finally {
      await pruning.teardown()
    }
  })

  it("never touches an admin-added row", async () => {
    // The whole point of the `source` column. A `manual` row is not an orphan
    // however empty the file is, and no restart disables or deletes it.
    const context = await contextWith("gw_reconcile_manual", {}, {
      oauth: { reconcile: { prune: true } },
    })
    await insertManual(context, "added-here")

    const diff = await reconcile(context)
    expect(diff.unchanged).toBe(true)

    const row = await gatewayRow(context, "added-here")
    expect(row?.source).toBe("manual")
    expect(row?.enabled).toBe(true)
  })

  it("lets the file claim a name an administrator had already used", async () => {
    // `name` is unique, so this collision has exactly one sane resolution: the
    // file wins and the row becomes file-owned. The alternative is a config
    // entry that silently does nothing.
    const context = await contextWith("gw_reconcile_claim", {
      shared: { url: "https://from-file.example" },
    })
    await insertManual(context, "shared", "https://from-admin.example")

    const diff = await reconcile(context)
    expect(diff.updated).toEqual(["shared"])
    const row = await gatewayRow(context, "shared")
    expect(row?.source).toBe("config")
    expect(row?.url).toBe("https://from-file.example")
  })

  it("records one audit row, naming ids and counts only", async () => {
    const context = await contextWith("gw_reconcile_audit", {
      data: { url: "https://postgrest.example" },
    })
    const { createAudit } = await import("@/server/audit")
    const { createLogger } = await import("@/server/logger")
    const audit = createAudit(
      context.database,
      createLogger({ level: "error", write: () => {} })
    )

    await reconcileGateways({
      config: context.config,
      database: context.database,
      locking: context.database,
      audit,
    })

    const rows = await context.database.db
      .select()
      .from(context.database.schema.auditLog)
      .where(
        eq(context.database.schema.auditLog.action, "gateway.reconciled")
      )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actorType).toBe("system")
    expect(rows[0]?.metadata).toMatchObject({ created: ["data"] })
    // Never the target URL: it can carry a host an operator would rather not
    // publish on a page an administrator reads (SEC-6).
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain("postgrest")
  })
})
