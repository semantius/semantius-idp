/**
 * The engine behind `/admin/database` (FR-ADMIN-7): schema introspection and
 * one-statement SQL execution against this deployment's own Postgres.
 *
 * Nothing here is reachable unless `admin.database` is set to something other
 * than `disabled` — `endpoints.ts` leaves both endpoints out of the returned
 * object entirely in that case, so Better Auth answers 404 rather than 403.
 * That is the house style for a feature that is off (the api-key plugin is
 * registered the same way) and it is what the owner asked for: with the flag
 * off the API must be absent, not merely unhelpful.
 *
 * **The handle is the caller's choice and it is never the shared one.** A
 * single statement like `select set_config('search_path', 'nowhere', false)`
 * is perfectly legal inside a READ ONLY transaction, and on a pooled
 * connection that session state outlives the transaction and is handed to the
 * next piece of ordinary application traffic that borrows the connection. So
 * the console gets its own dedicated `max: 1` handles, built in `runtime.ts`:
 * one on `database.url` for `read` and one on `database.directUrl` for
 * `read-write` (D74's mutual fallback means a single-endpoint deployment
 * resolves both names to the same string). Any poisoning a clever statement
 * manages is then contained to the console's own connection. Not the `locking`
 * handle either — its two connections are reserved for advisory locks.
 *
 * **The write barrier is `simple: false`, and it is load-bearing.** postgres.js
 * runs `sql.unsafe(query)` with no parameters through the *simple* query
 * protocol, which executes a multi-statement string as a script — so
 * `COMMIT; INSERT INTO "user" …` would end the READ ONLY transaction and then
 * write in autocommit, and `SET TRANSACTION READ WRITE` would do the same job
 * more directly. Passing `{ simple: false }` forces the extended protocol,
 * whose Parse step refuses any string carrying more than one command with
 * `42601` before a single byte of it executes. What is left is one statement,
 * which is exactly the unit the console is meant to run: writable CTEs still
 * die on `25006`, and the transaction is still the authority the component's
 * own client-side keyword guard explicitly is not.
 *
 * A dedicated read-only Postgres *role* was considered and rejected (D83): the
 * IdP owns one role, creating a second is a deployment-invasive change to
 * every install's provisioning, and the transaction-level guarantee is the
 * same one the role would give.
 */

// The default export, and `postgres.PostgresError` off it rather than a named
// import: postgres.js attaches the class with `Object.assign(Postgres, …)` and
// its ESM entry exports only the default, so `import { PostgresError }` throws
// `Export named 'PostgresError' not found` under Bun -- which is the runtime,
// and which the vitest gates do not exercise because Vite's interop invents
// the binding. Caught by `db:generate-schema --check`.
import postgres from "postgres"

import type { DbHandle } from "../db/client"
import { quoteIdentifier } from "../db/client"

/** How long any one statement may run. `SET LOCAL`, so it is pooler-safe. */
const STATEMENT_TIMEOUT_MS = 10_000

/** Rows past this are dropped and the caller is told (`truncated`). */
const MAX_ROWS = 500

/**
 * Per-cell ceiling, in characters.
 *
 * A row cap alone is not a size cap: `select repeat('x', 100000000)` is one
 * row, well inside `MAX_ROWS`, and 100 MB through the server-function
 * serializer and down the wire. Cells past this are cut and suffixed.
 */
const MAX_CELL_CHARS = 10_000

/** Ceiling on the whole serialized result. Rows stop being added past it. */
const MAX_RESULT_CHARS = 5_000_000

/** A cell as the browser will receive it. */
export type QueryCell = string | number | boolean | null

export interface QueryField {
  name: string
  /** The `pg_type` name for the column's OID, e.g. `text` or `timestamptz`. */
  type: string
}

export interface QuerySuccess {
  rows: Record<string, QueryCell>[]
  fields: QueryField[]
  /** Rows returned or affected, *before* truncation. */
  rowCount: number
  /** The Postgres command tag, e.g. `SELECT` or `INSERT`. */
  command: string
  durationMs: number
  /** Rows, cells or total size were cut. The page says so in its caption. */
  truncated: boolean
}

export interface QueryFailure {
  message: string
  /** The SQLSTATE, e.g. `25006` (read-only) or `57014` (timeout). */
  sqlstate?: string
  detail?: string
  hint?: string
  /** 1-based, derived from `PostgresError.position`. */
  line?: number
  /** 1-based, derived from `PostgresError.position`. */
  column?: number
}

export interface SchemaColumn {
  name: string
  type: string
  primaryKey?: boolean
  unique?: boolean
  nullable?: boolean
  references?: { table: string; column: string }
}

export interface SchemaIndex {
  name: string
  columns: string[]
  unique?: boolean
}

export interface SchemaTable {
  name: string
  schema?: string
  columns: SchemaColumn[]
  indexes?: SchemaIndex[]
  rowCount?: number
}

export interface DatabaseSchema {
  schemaName: string
  /** `current_database()`, which is what the runner labels itself with. */
  database: string
  tables: SchemaTable[]
}

/** One row of the tables query. */
export interface RawTable {
  name: string
  /** `pg_class.reltuples`; `-1` on a table `ANALYZE` has never seen. */
  estimate: number
}

/** One row of the columns query. */
export interface RawColumn {
  table: string
  name: string
  type: string
  nullable: boolean
  position: number
}

/** One row of the index query, already collapsed to one row per index. */
export interface RawIndex {
  table: string
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
}

/** One row of the foreign-key query, one per column pair. */
export interface RawForeignKey {
  table: string
  column: string
  targetTable: string
  targetColumn: string
}

export interface RawIntrospection {
  schemaName: string
  database: string
  tables: RawTable[]
  columns: RawColumn[]
  indexes: RawIndex[]
  foreignKeys: RawForeignKey[]
}

/**
 * Every schema on this database the console's role may look into (D84).
 *
 * `has_schema_privilege` rather than a bare listing: a schema the role cannot
 * read would introspect to an empty tree and look like an empty schema, which
 * is a worse answer than not offering it. `pg_catalog`, `pg_toast` and the
 * per-backend `pg_temp_*` schemas go, and `information_schema` with them,
 * because the selector is a list of *this* deployment's data rather than a
 * tour of the server's own bookkeeping. Nothing here widens what an
 * administrator can reach: `POST /idp/database/query` has always taken
 * arbitrary SQL, so every one of these schemas was already one `select` away.
 * What it widens is the *tree*, which used to describe `database.schema` and
 * nothing else.
 *
 * **`left(…, 3)` rather than `not like 'pg\_%'`**, which is the obvious
 * spelling and is wrong twice over here: a template literal eats the
 * backslash before postgres.js ever sees it (`\_` cooks to `_`), so the
 * pattern reaching Postgres is `pg_%` — where `_` is LIKE's own
 * any-single-character wildcard, and a schema called `pgx_things` would
 * quietly vanish from the selector. Doubling the backslash would work and
 * would have to be explained; a prefix comparison needs no explanation.
 */
export async function listSchemas(handle: DbHandle): Promise<string[]> {
  const rows = await handle.sql<{ name: string }[]>`
    select n.nspname as name
    from pg_namespace n
    where left(n.nspname, 3) <> 'pg_'
      and n.nspname <> 'information_schema'
      and has_schema_privilege(n.oid, 'USAGE')
    order by n.nspname
  `
  return rows.map((row) => row.name)
}

/**
 * The four introspection queries plus `current_database()`.
 *
 * Every one is parameterized on `$1 = schemaName` — the schema name is a
 * runtime configuration value, not a constant, and building it into the SQL by
 * concatenation is the shape this file exists to avoid on principle even
 * though an operator who can edit the config can already do worse.
 *
 * `schemaName` defaults to the handle's — the deployment's own
 * `database.schema` — and the caller passes another only after checking it
 * against `listSchemas` (D84). The check is not what makes this safe (the
 * name is a bind parameter either way); it is what keeps a typo from
 * rendering an empty tree that looks like an empty schema.
 *
 * The catalogs rather than `information_schema` wherever the catalog answers
 * a question the standard views cannot: `pg_class.reltuples` for the row
 * estimate (counting is O(table) and this is a sidebar), and
 * `pg_index`/`pg_constraint` for index and foreign-key *column order*, which
 * `information_schema.key_column_usage` reports but only after three joins.
 */
export async function introspectSchema(
  handle: DbHandle,
  schema?: string
): Promise<RawIntrospection> {
  const { sql } = handle
  const schemaName = schema ?? handle.schemaName

  const [databaseRow] = await sql<{ name: string }[]>`
    select current_database() as name
  `

  const tables = await sql<RawTable[]>`
    select c.relname as name, c.reltuples::float8 as estimate
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schemaName} and c.relkind in ('r', 'p', 'v', 'm')
    order by c.relname
  `

  // Every label that is a reserved word is quoted -- "table", "column",
  // "unique", "primary". Postgres accepts most keywords as a bare column
  // label but not the reserved ones, and `as table` is a syntax error.
  const columns = await sql<RawColumn[]>`
    select
      table_name as "table",
      column_name as name,
      -- udt_name is the compact spelling: timestamptz, rather than
      -- "timestamp with time zone", which is what fits in a tree row.
      udt_name as type,
      is_nullable = 'YES' as nullable,
      ordinal_position::int as position
    from information_schema.columns
    where table_schema = ${schemaName}
    order by table_name, ordinal_position
  `

  const indexes = await sql<RawIndex[]>`
    select
      t.relname as "table",
      i.relname as name,
      x.indisunique as "unique",
      x.indisprimary as "primary",
      array_agg(
        -- A null attname is an expression index: indkey carries 0 for those
        -- and there is no pg_attribute row to join to. The placeholder keeps
        -- the column order intact rather than dropping a position and
        -- silently mis-labelling every one after it.
        coalesce(a.attname::text, '(expression)') order by k.ordinality
      ) as columns
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    -- indkey is an int2vector, not an array, so it is cast before unnesting.
    cross join lateral unnest(x.indkey::int2[])
      with ordinality as k(attnum, ordinality)
    left join pg_attribute a
      on a.attrelid = t.oid and a.attnum = k.attnum and not a.attisdropped
    where n.nspname = ${schemaName}
    group by t.relname, i.relname, x.indisunique, x.indisprimary
    order by t.relname, i.relname
  `

  const foreignKeys = await sql<RawForeignKey[]>`
    select
      t.relname as "table",
      a.attname as "column",
      ft.relname as "targetTable",
      fa.attname as "targetColumn"
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_class ft on ft.oid = c.confrelid
    -- The two key arrays are positionally paired, so they are unnested
    -- together: conkey[i] references confkey[i]. Unnesting them separately
    -- would give the cross product and claim relationships that do not exist
    -- on any foreign key over more than one column.
    cross join lateral unnest(c.conkey, c.confkey) as k(src, dst)
    join pg_attribute a on a.attrelid = t.oid and a.attnum = k.src
    join pg_attribute fa on fa.attrelid = ft.oid and fa.attnum = k.dst
    where n.nspname = ${schemaName} and c.contype = 'f'
    order by t.relname, a.attname
  `

  return {
    schemaName,
    database: databaseRow?.name ?? "",
    tables,
    columns,
    indexes,
    foreignKeys,
  }
}

/**
 * Introspection rows → the shape `SchemaExplorer` wants.
 *
 * Split out from the queries so it can be unit-tested against fixtures: the
 * interesting cases (`reltuples = -1`, an expression index, a two-column
 * foreign key) are all in this mapping and none of them need a database.
 */
export function buildSchemaTables(raw: RawIntrospection): SchemaTable[] {
  const primaryKeyColumns = new Map<string, Set<string>>()
  const uniqueColumns = new Map<string, Set<string>>()
  for (const index of raw.indexes) {
    if (index.primary) {
      addAll(primaryKeyColumns, index.table, index.columns)
    } else if (index.unique) {
      addAll(uniqueColumns, index.table, index.columns)
    }
  }

  // Keyed on table and column joined by NUL, which no Postgres identifier can
  // contain -- a plain space separator collides on a quoted identifier that has
  // one in it, and `create table "my table"` is legal.
  const references = new Map<string, { table: string; column: string }>()
  for (const key of raw.foreignKeys) {
    // First wins. A column in two foreign keys is pathological, and the tree
    // has room for one arrow.
    const id = `${key.table}\u0000${key.column}`
    if (!references.has(id)) {
      references.set(id, { table: key.targetTable, column: key.targetColumn })
    }
  }

  const columnsByTable = new Map<string, RawColumn[]>()
  for (const column of raw.columns) {
    const list = columnsByTable.get(column.table)
    if (list) list.push(column)
    else columnsByTable.set(column.table, [column])
  }

  const indexesByTable = new Map<string, SchemaIndex[]>()
  for (const index of raw.indexes) {
    const entry: SchemaIndex = {
      name: index.name,
      columns: index.columns,
      ...(index.unique ? { unique: true } : {}),
    }
    const list = indexesByTable.get(index.table)
    if (list) list.push(entry)
    else indexesByTable.set(index.table, [entry])
  }

  return raw.tables.map((table) => {
    const pk = primaryKeyColumns.get(table.name)
    const unique = uniqueColumns.get(table.name)
    const indexes = indexesByTable.get(table.name)

    return {
      name: table.name,
      schema: raw.schemaName,
      columns: (columnsByTable.get(table.name) ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((column) => {
          const reference = references.get(`${table.name}\u0000${column.name}`)
          return {
            name: column.name,
            type: column.type,
            ...(pk?.has(column.name) ? { primaryKey: true } : {}),
            ...(unique?.has(column.name) ? { unique: true } : {}),
            ...(column.nullable ? { nullable: true } : {}),
            ...(reference ? { references: reference } : {}),
          }
        }),
      ...(indexes ? { indexes } : {}),
      // `reltuples` is -1 on a table `ANALYZE` has never visited, which is
      // every table in a deployment that started this morning. Omitting the
      // count is honest; rendering "-1 rows" is not.
      ...(table.estimate >= 0
        ? { rowCount: Math.round(table.estimate) }
        : {}),
    }
  })
}

function addAll(
  target: Map<string, Set<string>>,
  key: string,
  values: string[]
): void {
  const set = target.get(key)
  if (set) for (const value of values) set.add(value)
  else target.set(key, new Set(values))
}

export type QueryMode = "read" | "read-write"

/**
 * Run one statement and return what the runner needs to draw it.
 *
 * `mode` decides the *transaction*, not a keyword filter: `read` opens
 * `BEGIN READ ONLY`, and Postgres itself refuses the write with `25006`
 * wherever it hides — inside a writable CTE, behind a function, in a `DO`
 * block. The component ships its own keyword guard and its own documentation
 * says that guard is not a security boundary; this is the boundary.
 *
 * The caller picks `handle`. `read` gets the console's pooled handle and
 * `read-write` its direct one — see the file header for why neither is the
 * shared `runtime.database`.
 */
export async function runQuery(
  handle: DbHandle,
  query: string,
  mode: QueryMode
): Promise<QuerySuccess> {
  const started = performance.now()

  // Deliberately `async`, and the transaction body must stay that way.
  // `sql.begin` does `Promise.resolve(Array.isArray(x) ? Promise.all(x) : x)`
  // on whatever the callback returns, and a postgres.js result IS an array —
  // so a non-async callback returning the query directly would have its rows
  // rebuilt by `Promise.all` into a plain array, silently losing `command`,
  // `count` and `columns`. An async function returns a promise, which that
  // branch does not touch.
  const run = async (tx: postgres.TransactionSql) => {
    // Both `SET LOCAL`, via `set_config(..., true)`: scoped to this
    // transaction, so neither survives into whatever borrows the connection
    // next -- which is the same containment the file header argues for.
    //
    // **The search path has to be set here, and it is not belt-and-braces.**
    // `createDb` asks for one as a *startup parameter*, and its own comment
    // says that is best-effort because a transaction-mode pooler drops it --
    // true, and invisible everywhere else, because every query Drizzle emits
    // is schema-qualified. This console is the one place that runs SQL a
    // person typed, where an unqualified `select * from jwks` is the normal
    // spelling. Against a Neon `-pooler` endpoint it answered
    // `42P01 relation "jwks" does not exist` while the tree beside it listed
    // the table, which is the most confusing form the failure could take.
    await tx.unsafe(
      "select set_config('statement_timeout', $1, true), set_config('search_path', $2, true)",
      [String(STATEMENT_TIMEOUT_MS), `${quoteIdentifier(handle.schemaName)}, public`],
      EXTENDED_PROTOCOL
    )
    // The write barrier. See the file header: with an empty parameter list and
    // no options postgres.js picks the *simple* protocol, which executes
    // `COMMIT; <anything>` as a script.
    return await tx.unsafe(query, [], EXTENDED_PROTOCOL)
  }

  const result = (await (mode === "read"
    ? handle.sql.begin("read only", run)
    : handle.sql.begin(run))) as unknown as PostgresRows

  const durationMs = performance.now() - started
  return shapeResult(result, durationMs)
}

/**
 * postgres.js reads `options.simple` in `unsafe` (`src/index.js`:
 * `'simple' in options ? options.simple : args.length === 0`) but does not
 * declare it on `UnsafeQueryOptions`, which lists only `prepare`. Declaring
 * the widened shape here rather than casting at the call site keeps the option
 * visible: it is the whole write barrier, so if a dependency bump ever drops
 * it, this is the line that should stop compiling.
 */
interface ExtendedUnsafeOptions extends postgres.UnsafeQueryOptions {
  simple?: boolean
}

const EXTENDED_PROTOCOL: ExtendedUnsafeOptions = { simple: false }

/** What postgres.js hands back from `unsafe`, in the parts we read. */
interface PostgresRows extends Array<Record<string, unknown>> {
  command?: string
  count?: number
  columns?: { name: string; type: number }[]
}

/**
 * postgres.js result → the wire shape, capped three ways.
 *
 * Exported for the unit tests: every cap is a decision about what the browser
 * is asked to hold, and each one has a case that reaches it.
 */
export function shapeResult(
  result: PostgresRows,
  durationMs: number
): QuerySuccess {
  const columns = result.columns ?? []
  const fields: QueryField[] = columns.map((column) => ({
    name: column.name,
    type: typeNameFor(column.type),
  }))

  const rows: Record<string, QueryCell>[] = []
  let truncated = false
  let budget = MAX_RESULT_CHARS

  for (const source of result) {
    if (rows.length >= MAX_ROWS || budget <= 0) {
      truncated = true
      break
    }
    const row: Record<string, QueryCell> = {}
    for (const [key, value] of Object.entries(source)) {
      const cell = normalizeCell(value)
      if (typeof cell === "string" && cell.length > MAX_CELL_CHARS) {
        row[key] = `${cell.slice(0, MAX_CELL_CHARS)}…`
        truncated = true
        budget -= MAX_CELL_CHARS
      } else {
        row[key] = cell
        budget -= typeof cell === "string" ? cell.length : 8
      }
    }
    rows.push(row)
  }

  return {
    rows,
    fields,
    // `count` is the command tag's number, which for an `UPDATE` that returns
    // nothing is the only row count there is.
    rowCount: result.count ?? result.length,
    command: result.command ?? "",
    durationMs,
    truncated,
  }
}

/**
 * A cell the server-function serializer can carry.
 *
 * Everything crossing that seam has to survive `JSON.stringify` and arrive as
 * something the results grid can print. Dates become ISO strings (the grid
 * would otherwise print a revived `Date`'s locale form, which differs between
 * the SSR pass and the browser), `bigint` and `Buffer` become strings, and
 * anything structured becomes its JSON.
 */
export function normalizeCell(value: unknown): QueryCell {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * OID → type name, for the handful the console will actually meet.
 *
 * Resolving every OID would mean a `pg_type` lookup per query, and the label
 * is decoration on a column header. An OID with no entry prints as `oid:1234`,
 * which is still more use than a blank.
 */
const TYPE_NAMES: Record<number, string> = {
  16: "bool",
  17: "bytea",
  20: "int8",
  21: "int2",
  23: "int4",
  25: "text",
  26: "oid",
  114: "json",
  700: "float4",
  701: "float8",
  1042: "bpchar",
  1043: "varchar",
  1082: "date",
  1083: "time",
  1114: "timestamp",
  1184: "timestamptz",
  1700: "numeric",
  2950: "uuid",
  3802: "jsonb",
}

function typeNameFor(oid: number): string {
  return TYPE_NAMES[oid] ?? `oid:${oid}`
}

/**
 * A thrown error → the inline diagnostic the editor draws.
 *
 * `PostgresError.position` is a **1-based character offset into the query**,
 * which is not what the editor wants and is emphatically not `PostgresError.line`
 * — that one is the line number in Postgres's own C source file and pointing
 * a CodeMirror gutter at it produces a marker in a plausible but arbitrary
 * place. So: count the newlines before the offset.
 */
export function errorToQueryFailure(
  error: unknown,
  query: string
): QueryFailure {
  if (!(error instanceof postgres.PostgresError)) {
    return {
      message:
        error instanceof Error
          ? error.message
          : "The query failed. Check the SQL and try again.",
    }
  }

  const failure: QueryFailure = { message: error.message }
  if (error.code) failure.sqlstate = error.code
  if (error.detail) failure.detail = error.detail
  if (error.hint) failure.hint = error.hint

  const offset = Number(error.position)
  if (Number.isInteger(offset) && offset >= 1 && offset <= query.length + 1) {
    const before = query.slice(0, offset - 1)
    const lastBreak = before.lastIndexOf("\n")
    failure.line = before.split("\n").length
    failure.column = offset - lastBreak - 1
  }
  return failure
}
