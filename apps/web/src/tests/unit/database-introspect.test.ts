/**
 * The two pure parts of `/admin/database`'s server side (FR-ADMIN-7).
 *
 * `buildSchemaTables` is where every introspection edge case lands — a table
 * `ANALYZE` has never visited, an index over an expression, a foreign key
 * spanning two columns — and none of them need a database to reproduce. The
 * integration suite proves the *queries* return these shapes; this file proves
 * what is done with them.
 *
 * `errorToQueryFailure` is the other one, and it exists because
 * `PostgresError.position` is a 1-based character offset into the query while
 * `PostgresError.line` is the line number in Postgres's own C source. Pointing
 * a CodeMirror gutter at the second produces a marker in a plausible but
 * arbitrary place, which is worse than no marker at all.
 */

import { describe, expect, it } from "vitest"

// See `server/admin/database.ts`: postgres.js exports only a default, and the
// class hangs off it.
import postgres from "postgres"

import {
  buildSchemaTables,
  errorToQueryFailure,
  normalizeCell,
  shapeResult,
} from "@/server/admin/database"
import type { RawIntrospection } from "@/server/admin/database"

function introspection(
  overrides: Partial<RawIntrospection> = {}
): RawIntrospection {
  return {
    schemaName: "idp",
    database: "idp",
    tables: [],
    columns: [],
    indexes: [],
    foreignKeys: [],
    ...overrides,
  }
}

describe("buildSchemaTables", () => {
  it("marks primary keys, uniques, nullables and references", () => {
    const [session, user] = buildSchemaTables(
      introspection({
        tables: [
          { name: "session", estimate: 12 },
          { name: "user", estimate: 3 },
        ],
        columns: [
          { table: "user", name: "id", type: "text", nullable: false, position: 1 },
          {
            table: "user",
            name: "email",
            type: "text",
            nullable: false,
            position: 2,
          },
          {
            table: "user",
            name: "name",
            type: "text",
            nullable: true,
            position: 3,
          },
          {
            table: "session",
            name: "id",
            type: "text",
            nullable: false,
            position: 1,
          },
          {
            table: "session",
            name: "userId",
            type: "text",
            nullable: false,
            position: 2,
          },
        ],
        indexes: [
          {
            table: "user",
            name: "user_pkey",
            columns: ["id"],
            unique: true,
            primary: true,
          },
          {
            table: "user",
            name: "user_email_unique",
            columns: ["email"],
            unique: true,
            primary: false,
          },
        ],
        foreignKeys: [
          {
            table: "session",
            column: "userId",
            targetTable: "user",
            targetColumn: "id",
          },
        ],
      })
    )

    // Ordered by the tables query, not re-sorted here.
    expect(session?.name).toBe("session")
    expect(user?.name).toBe("user")
    expect(user?.schema).toBe("idp")

    expect(user?.columns).toEqual([
      { name: "id", type: "text", primaryKey: true },
      { name: "email", type: "text", unique: true },
      { name: "name", type: "text", nullable: true },
    ])
    // The primary key's index is not repeated in `unique`: it is already the
    // stronger statement, and the tree would draw two badges for one fact.
    expect(user?.columns[0]?.unique).toBeUndefined()

    expect(session?.columns[1]?.references).toEqual({
      table: "user",
      column: "id",
    })
    // Only the *non*-primary unique index is listed; the tree draws primary
    // keys from the column badge.
    expect(user?.indexes).toEqual([
      { name: "user_pkey", columns: ["id"], unique: true },
      { name: "user_email_unique", columns: ["email"], unique: true },
    ])
    expect(user?.rowCount).toBe(3)
  })

  it("omits the row count on a table ANALYZE has never seen", () => {
    // `reltuples` is -1 there, which is every table in a deployment that
    // started this morning. "-1 rows" in the tree would be a lie; no number
    // is the truth.
    const [table] = buildSchemaTables(
      introspection({ tables: [{ name: "audit_log", estimate: -1 }] })
    )
    expect(table).toBeDefined()
    expect(table).not.toHaveProperty("rowCount")
  })

  it("rounds a fractional estimate rather than printing it", () => {
    const [table] = buildSchemaTables(
      introspection({ tables: [{ name: "user", estimate: 41.6 }] })
    )
    expect(table?.rowCount).toBe(42)
  })

  it("keeps an expression index's column positions", () => {
    // `pg_index.indkey` carries 0 for an expression, which has no
    // `pg_attribute` row — the query substitutes a placeholder rather than
    // dropping the position, or every column after it shifts one left and the
    // index reads as being over the wrong columns.
    const [table] = buildSchemaTables(
      introspection({
        tables: [{ name: "user", estimate: 0 }],
        indexes: [
          {
            table: "user",
            name: "user_lower_email_idx",
            columns: ["(expression)", "status"],
            unique: false,
            primary: false,
          },
        ],
      })
    )
    expect(table?.indexes).toEqual([
      { name: "user_lower_email_idx", columns: ["(expression)", "status"] },
    ])
  })

  it("pairs a two-column foreign key column-for-column", () => {
    const [table] = buildSchemaTables(
      introspection({
        tables: [{ name: "child", estimate: 0 }],
        columns: [
          {
            table: "child",
            name: "tenant",
            type: "text",
            nullable: false,
            position: 1,
          },
          {
            table: "child",
            name: "parent",
            type: "text",
            nullable: false,
            position: 2,
          },
        ],
        foreignKeys: [
          {
            table: "child",
            column: "tenant",
            targetTable: "parent",
            targetColumn: "tenant",
          },
          {
            table: "child",
            column: "parent",
            targetTable: "parent",
            targetColumn: "id",
          },
        ],
      })
    )
    expect(table?.columns.map((column) => column.references)).toEqual([
      { table: "parent", column: "tenant" },
      { table: "parent", column: "id" },
    ])
  })

  it("orders columns by ordinal position, not by arrival", () => {
    const [table] = buildSchemaTables(
      introspection({
        tables: [{ name: "user", estimate: 0 }],
        columns: [
          { table: "user", name: "c", type: "text", nullable: false, position: 3 },
          { table: "user", name: "a", type: "text", nullable: false, position: 1 },
          { table: "user", name: "b", type: "text", nullable: false, position: 2 },
        ],
      })
    )
    expect(table?.columns.map((column) => column.name)).toEqual(["a", "b", "c"])
  })
})

/** Builds the `PostgresError` shape without going near a server. */
function postgresError(
  fields: Record<string, string>
): postgres.PostgresError {
  const error = Object.create(
    postgres.PostgresError.prototype
  ) as postgres.PostgresError & Record<string, unknown>
  Object.assign(error, { message: "boom", ...fields })
  return error
}

describe("errorToQueryFailure", () => {
  it("turns a character offset into a line and a column", () => {
    const query = "select 1\nfrom nowhere\nwhere x = 1"
    // Offset 15 is 1-based, so it is the 6th character of line 2.
    const failure = errorToQueryFailure(
      postgresError({ position: "15", code: "42P01" }),
      query
    )
    expect(failure.line).toBe(2)
    expect(failure.column).toBe(6)
    expect(failure.sqlstate).toBe("42P01")
  })

  it("puts the first character at line 1, column 1", () => {
    const failure = errorToQueryFailure(
      postgresError({ position: "1", code: "42601" }),
      "COMMIT; insert into x values (1)"
    )
    expect(failure).toMatchObject({ line: 1, column: 1, sqlstate: "42601" })
  })

  it("carries detail and hint through", () => {
    const failure = errorToQueryFailure(
      postgresError({
        code: "25006",
        detail: "the transaction is read-only",
        hint: "set the console to read-write",
        position: "",
      }),
      "insert into x values (1)"
    )
    expect(failure).toMatchObject({
      sqlstate: "25006",
      detail: "the transaction is read-only",
      hint: "set the console to read-write",
    })
    // No usable position, so no marker rather than a marker at 1,1.
    expect(failure.line).toBeUndefined()
  })

  it("leaves a non-Postgres error with nothing but its message", () => {
    const failure = errorToQueryFailure(new Error("connection lost"), "select 1")
    expect(failure).toEqual({ message: "connection lost" })
  })

  it("refuses an offset past the end of the query", () => {
    // A `position` longer than the string means the two disagree about what
    // ran; a marker built from it would land nowhere.
    const failure = errorToQueryFailure(
      postgresError({ position: "500", code: "42601" }),
      "select 1"
    )
    expect(failure.line).toBeUndefined()
    expect(failure.column).toBeUndefined()
  })
})

describe("normalizeCell", () => {
  it("sends a timestamp as ISO-8601, not a revived Date", () => {
    // The grid would otherwise print the browser's locale form on the client
    // and the server's on the SSR pass, which React reports as a hydration
    // mismatch on any row carrying a timestamp.
    expect(normalizeCell(new Date("2026-08-28T09:30:00.000Z"))).toBe(
      "2026-08-28T09:30:00.000Z"
    )
  })

  it("stringifies what JSON cannot carry", () => {
    expect(normalizeCell(9_007_199_254_740_993n)).toBe("9007199254740993")
    expect(normalizeCell(new Uint8Array([0xde, 0xad]))).toBe("\\xdead")
    expect(normalizeCell({ a: 1 })).toBe('{"a":1}')
    expect(normalizeCell(undefined)).toBeNull()
    expect(normalizeCell(null)).toBeNull()
  })

  it("keeps a non-finite number readable", () => {
    // `JSON.stringify(NaN)` is `null`, which would print as NULL and claim the
    // column was empty.
    expect(normalizeCell(Number.NaN)).toBe("NaN")
    expect(normalizeCell(Number.POSITIVE_INFINITY)).toBe("Infinity")
  })
})

/** A postgres.js result: an array carrying `command`, `count` and `columns`. */
function pgResult(
  rows: Record<string, unknown>[],
  meta: { command?: string; count?: number; columns?: { name: string; type: number }[] } = {}
) {
  return Object.assign(rows, {
    command: meta.command ?? "SELECT",
    count: meta.count ?? rows.length,
    columns: meta.columns ?? [],
  })
}

describe("shapeResult", () => {
  it("caps at 500 rows and says so", () => {
    const rows = Array.from({ length: 600 }, (_, index) => ({ n: index }))
    const result = shapeResult(pgResult(rows), 5)
    expect(result.rows).toHaveLength(500)
    expect(result.truncated).toBe(true)
    // `rowCount` is what the query actually produced, before the cap: the
    // caption says "the first 500 of these".
    expect(result.rowCount).toBe(600)
  })

  it("caps a single enormous cell", () => {
    // `select repeat('x', 100000000)` is one row, well inside the row cap, and
    // 100 MB through the server-function serializer.
    const result = shapeResult(pgResult([{ big: "x".repeat(50_000) }]), 5)
    const cell = result.rows[0]?.big
    expect(typeof cell).toBe("string")
    expect((cell as string).length).toBe(10_001)
    expect((cell as string).endsWith("…")).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it("resolves column type names from their OIDs", () => {
    const result = shapeResult(
      pgResult([{ id: "x", at: "y" }], {
        columns: [
          { name: "id", type: 2950 },
          { name: "at", type: 1184 },
        ],
      }),
      5
    )
    expect(result.fields).toEqual([
      { name: "id", type: "uuid" },
      { name: "at", type: "timestamptz" },
    ])
  })

  it("labels an OID it does not know rather than leaving a blank", () => {
    const result = shapeResult(
      pgResult([{ x: 1 }], { columns: [{ name: "x", type: 123_456 }] }),
      5
    )
    expect(result.fields).toEqual([{ name: "x", type: "oid:123456" }])
  })

  it("leaves an ordinary result untruncated", () => {
    const result = shapeResult(pgResult([{ one: 1 }], { command: "SELECT" }), 3)
    expect(result).toMatchObject({
      rows: [{ one: 1 }],
      rowCount: 1,
      command: "SELECT",
      durationMs: 3,
      truncated: false,
    })
  })
})
