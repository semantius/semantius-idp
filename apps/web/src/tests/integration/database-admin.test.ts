/**
 * `/admin/database`'s two endpoints, against a real Postgres (FR-ADMIN-7).
 *
 * The interesting half is not "does `select 1` work". It is the boundary: the
 * console's whole safety story is that a `read` statement runs inside a
 * `BEGIN READ ONLY` and Postgres refuses everything that would write, and that
 * story has exactly one way to be wrong — a statement that ends the
 * transaction before writing. postgres.js runs `unsafe(query)` with no
 * parameters through the *simple* protocol, which executes a multi-statement
 * string as a script, so `COMMIT; INSERT …` would have done precisely that.
 * `runQuery` passes `{ simple: false }`, the extended protocol's Parse step
 * refuses more than one command with `42601`, and the tests below are what
 * hold that in place.
 *
 * The other half is the flag. `disabled` has to remove the *API*, not only the
 * page — the owner's explicit requirement — which means 404 rather than 403,
 * and 404 is only convincing if a `read-only` context answers 200 for the same
 * call.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { desc, eq } from "drizzle-orm"

import { createLocalAccountIssuer } from "@better-auth/core/db"

import { createUserWithoutRequest } from "@/server/auth/provisioning"
import { authRequest, createTestContext, sessionCookie } from "./harness"
import type { TestContext } from "./harness"

const PASSWORD = "correct-horse-battery-staple"

/** Creates a user directly, so the test controls the role exactly. */
async function makeUser(
  ctx: TestContext,
  email: string,
  role?: string
): Promise<string> {
  const context = await ctx.auth.$context
  const user = await createUserWithoutRequest(
    context,
    { email, name: email, emailVerified: true, ...(role ? { role } : {}) },
    { method: "admin" }
  )
  await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: user.id,
    password: await context.password.hash(PASSWORD),
  })
  return user.id
}

async function signIn(ctx: TestContext, email: string): Promise<string> {
  const response = await ctx.auth.handler(
    authRequest("/sign-in/email", { json: { email, password: PASSWORD } })
  )
  const cookie = sessionCookie(response)
  expect(cookie, `sign-in failed for ${email}`).toBeTruthy()
  return cookie!
}

function query(
  ctx: TestContext,
  cookie: string,
  body: { query: string; mode?: string }
): Promise<Response> {
  return ctx.auth.handler(
    authRequest("/idp/database/query", {
      json: body,
      headers: { cookie },
    })
  )
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json().catch(() => null)) as unknown
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {}
}

describe("the read-only console", () => {
  let ctx: TestContext
  let cookie: string

  beforeAll(async () => {
    ctx = await createTestContext("database-admin", {
      config: { admin: { database: "read-only" }, apiKeys: { enabled: true } },
    })
    await makeUser(ctx, "console-admin@example.com", "admin")
    cookie = await signIn(ctx, "console-admin@example.com")
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  beforeEach(async () => {
    await ctx.database.db.delete(ctx.database.schema.auditLog)
  })

  async function auditRows() {
    return ctx.database.db
      .select()
      .from(ctx.database.schema.auditLog)
      .where(eq(ctx.database.schema.auditLog.action, "database.queried"))
      .orderBy(desc(ctx.database.schema.auditLog.createdAt))
  }

  /** How many rows the `user` table holds, read outside the console. */
  async function userCount(): Promise<number> {
    const rows = await ctx.database.sql<{ n: string }[]>`
      select count(*) as n from ${ctx.database.sql(ctx.schemaName)}."user"
    `
    return Number(rows[0]?.n ?? 0)
  }

  describe("introspection", () => {
    it("describes the schema the deployment actually runs on", async () => {
      const response = await ctx.auth.handler(
        authRequest("/idp/database/schema", { headers: { cookie } })
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        schemaName: string
        database: string
        mode: string
        tables: {
          name: string
          columns: {
            name: string
            type: string
            primaryKey?: boolean
            nullable?: boolean
            references?: { table: string; column: string }
          }[]
          indexes?: { name: string; columns: string[]; unique?: boolean }[]
        }[]
      }

      expect(body.schemaName).toBe(ctx.schemaName)
      expect(body.database).toBeTruthy()
      // The *deployment's* mode, which is what tells the page whether to draw
      // a write toggle.
      expect(body.mode).toBe("read-only")

      const user = body.tables.find((table) => table.name === "user")
      expect(user, "the user table is missing from the schema tree").toBeDefined()
      expect(user!.columns.map((column) => column.name)).toContain("email")
      expect(
        user!.columns.find((column) => column.name === "id")?.primaryKey
      ).toBe(true)

      // The foreign key is the part the naive query gets wrong: `conkey` and
      // `confkey` have to be unnested together or a multi-column key claims
      // relationships it does not have.
      const session = body.tables.find((table) => table.name === "session")
      expect(
        session?.columns.find((column) => column.name === "user_id")?.references
      ).toEqual({ table: "user", column: "id" })
    })

    it("reports column types in their compact spelling", async () => {
      const response = await ctx.auth.handler(
        authRequest("/idp/database/schema", { headers: { cookie } })
      )
      const body = (await response.json()) as {
        tables: { name: string; columns: { name: string; type: string }[] }[]
      }
      const createdAt = body.tables
        .find((table) => table.name === "user")
        ?.columns.find((column) => column.name === "created_at")
      // `udt_name`, not `data_type`: "timestamp with time zone" does not fit
      // in a tree row and `timestamptz` is what an operator writes anyway.
      expect(createdAt?.type).toMatch(/^timestamp/)
    })
  })

  describe("running a statement", () => {
    it("returns rows, fields and the command tag", async () => {
      const response = await query(ctx, cookie, {
        query: "select 1 as one, 'two' as two",
      })
      expect(response.status).toBe(200)
      const body = await bodyOf(response)
      expect(body.rows).toEqual([{ one: 1, two: "two" }])
      expect(body.fields).toEqual([
        { name: "one", type: "int4" },
        { name: "two", type: "text" },
      ])
      expect(body.command).toBe("SELECT")
      expect(body.rowCount).toBe(1)
      expect(body.truncated).toBe(false)
    })

    it("writes a success row carrying the statement, rows and duration", async () => {
      await query(ctx, cookie, { query: "select 1 as one" })
      const [row] = await auditRows()
      expect(row?.outcome).toBe("success")
      expect(row?.actorType).toBe("session")
      expect(row?.actorUserId).toBeTruthy()
      const metadata = row?.metadata as Record<string, unknown>
      expect(metadata.query).toBe("select 1 as one")
      expect(metadata.mode).toBe("read")
      expect(metadata.rowCount).toBe(1)
      expect(metadata.command).toBe("SELECT")
      expect(typeof metadata.durationMs).toBe("number")
    })

    it("caps at 500 rows and says it did", async () => {
      const response = await query(ctx, cookie, {
        query: "select generate_series(1, 600) as n",
      })
      const body = await bodyOf(response)
      expect((body.rows as unknown[]).length).toBe(500)
      expect(body.truncated).toBe(true)
      // The count is what the query produced, so the caption can say "the
      // first 500 of 600".
      expect(body.rowCount).toBe(600)
    })

    it("cuts a cell that would otherwise be megabytes", async () => {
      // One row, well inside the row cap, and 50 kB of it. A row cap alone is
      // not a size cap.
      const response = await query(ctx, cookie, {
        query: "select repeat('x', 50000) as big",
      })
      const body = await bodyOf(response)
      const cell = (body.rows as { big: string }[])[0]?.big
      expect(cell?.length).toBe(10_001)
      expect(cell?.endsWith("…")).toBe(true)
      expect(body.truncated).toBe(true)
    })
  })

  describe("the write barrier", () => {
    it("refuses a plain INSERT with 25006 and writes nothing", async () => {
      const before = await userCount()
      const response = await query(ctx, cookie, {
        query: `insert into "user" (id, email, name, "created_at", "updated_at") values ('x', 'x@example.com', 'x', now(), now())`,
      })
      expect(response.status).toBe(400)
      const body = await bodyOf(response)
      expect(body.code).toBe("QUERY_FAILED")
      // 25006 is `read_only_sql_transaction` — the database refusing, which
      // is the only refusal this feature relies on.
      expect(body.sqlstate).toBe("25006")
      expect(await userCount()).toBe(before)

      const [row] = await auditRows()
      expect(row?.outcome).toBe("failure")
      expect((row?.metadata as Record<string, unknown>).reason).toBe("25006")
    })

    it("refuses `COMMIT; INSERT …` at Parse, before anything runs", async () => {
      // **The case this whole design turns on.** With postgres.js's simple
      // protocol this string would end the READ ONLY transaction and then
      // write in autocommit. The extended protocol refuses any
      // multi-statement string with 42601 before executing a byte of it.
      const before = await userCount()
      const response = await query(ctx, cookie, {
        query: `COMMIT; insert into "user" (id, email, name, "created_at", "updated_at") values ('escape', 'escape@example.com', 'escape', now(), now())`,
      })
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).sqlstate).toBe("42601")
      expect(await userCount()).toBe(before)
    })

    it("refuses `SET TRANSACTION READ WRITE; …` the same way", async () => {
      const before = await userCount()
      const response = await query(ctx, cookie, {
        query: `SET TRANSACTION READ WRITE; delete from "user"`,
      })
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).sqlstate).toBe("42601")
      expect(await userCount()).toBe(before)
    })

    it("refuses a bare second statement, however harmless", async () => {
      const response = await query(ctx, cookie, {
        query: "select 1; select 2",
      })
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).sqlstate).toBe("42601")
    })

    it("refuses a writable CTE, which no keyword scan would catch", async () => {
      // The statement starts with SELECT, so the component's own client-side
      // guard would let it through — which is exactly why that guard is not
      // the boundary and this transaction is.
      const before = await userCount()
      const response = await query(ctx, cookie, {
        query: `with gone as (delete from "user" returning id) select count(*) from gone`,
      })
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).sqlstate).toBe("25006")
      expect(await userCount()).toBe(before)
    })

    it("refuses a requested read-write mode outright", async () => {
      const response = await query(ctx, cookie, {
        query: "select 1",
        mode: "read-write",
      })
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).code).toBe("WRITE_NOT_ALLOWED")

      const [row] = await auditRows()
      expect(row?.outcome).toBe("denied")
      // `reason`, not `code`: `redactFields` masks a key called `code`.
      expect((row?.metadata as Record<string, unknown>).reason).toBe(
        "WRITE_NOT_ALLOWED"
      )
    })
  })

  describe("errors an operator can act on", () => {
    it("carries the SQLSTATE and an editor position", async () => {
      const response = await query(ctx, cookie, {
        query: "select 1\nfrom no_such_table_anywhere",
      })
      expect(response.status).toBe(400)
      const body = await bodyOf(response)
      expect(body.sqlstate).toBe("42P01")
      expect(body.line).toBe(2)
      expect(typeof body.column).toBe("number")
    })
  })

  describe("who may call it", () => {
    it("answers an ordinary user 403 on both endpoints", async () => {
      await makeUser(ctx, "not-an-admin@example.com")
      const ordinary = await signIn(ctx, "not-an-admin@example.com")

      expect(
        (
          await ctx.auth.handler(
            authRequest("/idp/database/schema", {
              headers: { cookie: ordinary },
            })
          )
        ).status
      ).toBe(403)
      expect((await query(ctx, ordinary, { query: "select 1" })).status).toBe(
        403
      )
    })

    it("answers an anonymous caller 401", async () => {
      expect(
        (await ctx.auth.handler(authRequest("/idp/database/schema"))).status
      ).toBe(401)
    })

    it("works with an admin API key, so `curl` reaches it too", async () => {
      // FR-ADMIN-6: the API is the interface and the page is one of its
      // callers. `requireAdmin`'s D35 fallback is what makes this work.
      const created = await ctx.auth.handler(
        authRequest("/api-key/create", {
          json: { name: "console" },
          headers: { cookie },
        })
      )
      const key = ((await created.json()) as { key: string }).key
      expect(key).toBeTruthy()

      const response = await ctx.auth.handler(
        authRequest("/idp/database/query", {
          json: { query: "select 1 as one" },
          headers: { "x-api-key": key },
        })
      )
      expect(response.status).toBe(200)
      expect((await bodyOf(response)).rows).toEqual([{ one: 1 }])
    })
  })
})

describe("a read-write console", () => {
  let ctx: TestContext
  let cookie: string

  beforeAll(async () => {
    ctx = await createTestContext("database-rw", {
      config: { admin: { database: "read-write" } },
    })
    await makeUser(ctx, "rw-admin@example.com", "admin")
    cookie = await signIn(ctx, "rw-admin@example.com")
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  it("commits a write when the request asks for one", async () => {
    const response = await query(ctx, cookie, {
      query: `insert into "user" (id, email, name, "created_at", "updated_at") values ('written', 'written@example.com', 'written', now(), now())`,
      mode: "read-write",
    })
    expect(response.status).toBe(200)
    expect((await bodyOf(response)).command).toBe("INSERT")

    // Committed, and visible to a different connection — which is the whole
    // claim. Read over the shared handle, not the console's.
    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.id, "written"))
    expect(rows).toHaveLength(1)
  })

  it("still refuses the same statement in read mode", async () => {
    const response = await query(ctx, cookie, {
      query: `insert into "user" (id, email, name, "created_at", "updated_at") values ('refused', 'refused@example.com', 'refused', now(), now())`,
      mode: "read",
    })
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).sqlstate).toBe("25006")

    const rows = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.id, "refused"))
    expect(rows).toHaveLength(0)
  })

  it("defaults to read when the request names no mode", async () => {
    const response = await query(ctx, cookie, {
      query: `insert into "user" (id, email, name, "created_at", "updated_at") values ('defaulted', 'defaulted@example.com', 'd', now(), now())`,
    })
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).sqlstate).toBe("25006")
  })
})

describe("a disabled console", () => {
  let ctx: TestContext
  let cookie: string

  beforeAll(async () => {
    // No `admin.database` at all: the default, which is `disabled`.
    ctx = await createTestContext("database-off")
    await makeUser(ctx, "off-admin@example.com", "admin")
    cookie = await signIn(ctx, "off-admin@example.com")
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  it("has no endpoints to answer, for an administrator or anyone else", async () => {
    // 404, not 403. The owner's requirement is that a `disabled` deployment
    // has no API either, and Better Auth answers 404 for a route it was never
    // handed — the same shape `apiKeys.enabled: false` produces.
    expect(
      (
        await ctx.auth.handler(
          authRequest("/idp/database/schema", { headers: { cookie } })
        )
      ).status
    ).toBe(404)
    expect((await query(ctx, cookie, { query: "select 1" })).status).toBe(404)
  })
})
