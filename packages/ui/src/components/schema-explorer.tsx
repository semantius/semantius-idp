"use client";

/**
 * **A fork of ui.neon.com's `SchemaExplorer`, not registry output any more**
 * (D84). It was vendored verbatim under D83; the owner then asked for a run
 * control on every table row, which the registry component has no prop for;
 * **D87** then made the card fill its container and **D88** took the row
 * estimate off it. Six divergences, each marked `Fork (D84)`, `Fork (D87)`
 * or `Fork (D88)` where it sits:
 *
 * 1. `onTableAction` / `tableActionLabel` — the per-row button.
 * 2. A table row is a `div role="treeitem"` rather than a `button` carrying
 *    that role, because a `button` inside a `button` is invalid HTML that the
 *    parser un-nests, which is a hydration mismatch. See the note on
 *    `TableRow` for why a *sibling* button will not do either.
 * 3. The action's Enter and Space are stopped short of the tree's own key
 *    handler.
 * 4. `titleSlot` — a header that is a control rather than a label — and the
 *    removal of the `/ to search` hint that used to sit opposite it.
 * 5. **The row estimate is not drawn** (**D88**). `Table.rowCount` stays in
 *    the interface, because the endpoint still returns it; the tree ignores
 *    it. `formatCount`, which had no other caller, went with it.
 * 6. **It fills its container instead of capping the tree at `max-h-96`**
 *    (**D87**). The card is a flex column and the tree is its `flex-1` row,
 *    so a caller that gives the card a height gets a tree that grows and
 *    shrinks with the window. Given no height it still behaves — a column
 *    whose only growable row has `min-h-0` is its content's height — but the
 *    24 rem ceiling is gone, so a caller that wants one now says so.
 *
 * Re-running `shadcn add schema-explorer` overwrites all six. That is the
 * cost of the fork and it is written down rather than discovered.
 */

import {
  ArrowRight01Icon,
  Cancel01Icon,
  Database01Icon,
  HashIcon,
  Key01Icon,
  Link01Icon,
  PlayIcon,
  Search01Icon,
  Table01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

import { cn } from "@workspace/ui/lib/utils";

export interface ColumnRef {
  table: string;
  column: string;
}

export interface Column {
  name: string;
  /** SQL type, e.g. "uuid", "text", or "timestamptz". */
  type: string;
  primaryKey?: boolean;
  unique?: boolean;
  nullable?: boolean;
  references?: ColumnRef;
}

export interface Index {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface Table {
  name: string;
  /** Postgres schema; defaults to "public". */
  schema?: string;
  columns: Column[];
  indexes?: Index[];
  /**
   * Approximate row count. **Accepted and not drawn** (fork, D88) — see the
   * note on `TableRow` for why a `pg_class.reltuples` estimate is the wrong
   * thing to put beside a table name.
   */
  rowCount?: number;
}

interface TreeRow {
  id: string;
  kind: "table" | "column" | "index" | "relation";
  table: Table;
  column?: Column;
  index?: Index;
}

const normalize = (value: string) => value.trim().toLowerCase();

const includesQuery = (value: string, query: string) =>
  value.toLowerCase().includes(query);

const getTableMatches = (table: Table, query: string) => {
  if (!query || includesQuery(table.name, query)) {
    return {
      columns: table.columns,
      indexes: table.indexes ?? [],
      tableMatches: true,
    };
  }

  return {
    columns: table.columns.filter(
      (column) =>
        includesQuery(column.name, query) || includesQuery(column.type, query)
    ),
    indexes: (table.indexes ?? []).filter(
      (index) =>
        includesQuery(index.name, query) ||
        index.columns.some((column) => includesQuery(column, query))
    ),
    tableMatches: false,
  };
};

const getVisibleRows = (
  tables: Table[],
  openTables: Set<string>,
  query: string
) => {
  const rows: TreeRow[] = [];
  for (const table of tables) {
    const matches = getTableMatches(table, query);
    const relations = matches.columns.filter((column) => column.references);
    const isVisible =
      matches.tableMatches ||
      matches.columns.length > 0 ||
      matches.indexes.length > 0;

    if (!isVisible) {
      continue;
    }

    rows.push({ id: `table:${table.name}`, kind: "table", table });
    if (!(openTables.has(table.name) || query)) {
      continue;
    }

    for (const column of matches.columns) {
      rows.push({
        column,
        id: `column:${table.name}:${column.name}`,
        kind: "column",
        table,
      });
    }
    for (const index of matches.indexes) {
      rows.push({
        id: `index:${table.name}:${index.name}`,
        index,
        kind: "index",
        table,
      });
    }
    for (const column of relations) {
      rows.push({
        column,
        id: `relation:${table.name}:${column.name}`,
        kind: "relation",
        table,
      });
    }
  }
  return rows;
};

const Match = ({ children, query }: { children: string; query: string }) => {
  if (!query) {
    return children;
  }
  const start = children.toLowerCase().indexOf(query);
  if (start === -1) {
    return children;
  }
  const end = start + query.length;
  return (
    <>
      {children.slice(0, start)}
      <mark className="rounded-sm bg-primary/15 text-primary">
        {children.slice(start, end)}
      </mark>
      {children.slice(end)}
    </>
  );
};

const Constraint = ({ children }: { children: string }) => (
  <span className="rounded-[3px] border border-border/70 bg-background px-1 py-px font-medium text-[9px] text-muted-foreground leading-none">
    {children}
  </span>
);

/**
 * Fork (D84). **The row is a `div` carrying `role="treeitem"`, not a
 * `button`.** The action has to live inside the row: a `tree` may own nothing
 * but `treeitem` and `group`, so a button rendered as the row's *sibling* is
 * an axe `aria-required-children` violation — critical, and the R-1 gate
 * scans this page. Inside the row it is legal, because `treeitem` is not one
 * of the roles whose children must be presentational, which is what
 * `nested-interactive` keys on. A `button` inside a `button` is not an
 * option: the HTML parser un-nests it and the hydrated tree no longer matches
 * the streamed one.
 *
 * What the element change costs is the native button's Enter and Space, and
 * the tree's own key handler was already doing that job for table rows.
 */
const TableRow = ({
  treeId,
  table,
  open,
  query,
  active,
  tabIndex,
  onFocus,
  onToggle,
  actionLabel,
  onAction,
}: {
  treeId: string;
  table: Table;
  open: boolean;
  query: string;
  active: boolean;
  tabIndex: number;
  onFocus: () => void;
  onToggle: () => void;
  actionLabel?: string;
  onAction?: () => void;
}) => (
  <div
    aria-expanded={open}
    aria-level={1}
    className={cn(
      "group flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left outline-none",
      // Fork (D84). Preflight gives a `button` the pointer and the
      // unselectable text; a `div` has to ask for both, or the row it used to
      // be starts selecting its own label on a drag.
      "cursor-pointer select-none",
      "hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50",
      "active:bg-muted data-[state=open]:bg-muted/35",
      // The action sits at the right-hand edge and brings its own padding.
      onAction && "pr-1"
    )}
    data-active={active ? "true" : undefined}
    data-state={open ? "open" : "closed"}
    data-tree-id={treeId}
    onClick={onToggle}
    onFocus={onFocus}
    role="treeitem"
    tabIndex={tabIndex}
  >
    <HugeiconsIcon
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-100 motion-reduce:transition-none",
        open && "rotate-90"
      )}
      icon={ArrowRight01Icon}
      strokeWidth={2}
    />
    <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border/60 bg-background shadow-xs">
      <HugeiconsIcon
        aria-hidden="true"
        className="size-3.5 text-muted-foreground group-data-[state=open]:text-foreground"
        icon={Table01Icon}
        strokeWidth={2}
      />
    </span>
    <span className="min-w-0 truncate font-medium text-xs">
      <Match query={query}>{table.name}</Match>
    </span>
    {/* Fork (D88). The row estimate is **not drawn**, and `table.rowCount`
        is deliberately left unread. It is `pg_class.reltuples`, which is a
        planner statistic and not a count: `-1` until something gathers
        statistics, and nothing does on a table that is merely written to.
        Measured on a throwaway database rather than recalled: `CREATE
        TABLE` with its indexes built while empty leaves `-1`, three inserts
        leave `-1`, and only `ANALYZE`, `VACUUM` or an index built over rows
        that already exist sets it. A schema whose migrations create every
        table before a single row arrives therefore starts at `-1` and stays
        there until autovacuum's analyse pass, which triggers at **fifty
        modifications** — so what the column really reported was *write
        volume*. `rate_limit` alone had one, because `rateLimit.storage:
        "database"` updates it on nearly every request while it holds two
        rows; the other seventeen tables showed nothing, several of them
        holding more rows than it did. A number that appears on the least populated table
        and on no other is worse than no number. The endpoint still returns
        it (FR-ADMIN-7), where it is documented as an estimate and read by
        something that can treat it as one. */}
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground tabular-nums">
      <span>{table.columns.length} columns</span>
    </span>
    {onAction ? (
      // Fork (D84). `stopPropagation` on the click, or the row toggles open
      // behind the statement it just ran; on Enter and Space, or the tree's
      // own handler does the same thing a keystroke later. Arrow keys are
      // deliberately left to bubble, so navigation still works from here.
      <button
        aria-label={actionLabel}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none",
          "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
          "active:scale-[0.96] motion-reduce:active:scale-100"
        )}
        onClick={(event) => {
          event.stopPropagation();
          onAction();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
        tabIndex={tabIndex}
        title={actionLabel}
        type="button"
      >
        <HugeiconsIcon
          aria-hidden="true"
          className="size-3"
          icon={PlayIcon}
          strokeWidth={2}
        />
      </button>
    ) : null}
  </div>
);

const LeafRow = ({
  treeId,
  row,
  query,
  active,
  tabIndex,
  onFocus,
  onSelect,
}: {
  treeId: string;
  row: TreeRow;
  query: string;
  active: boolean;
  tabIndex: number;
  onFocus: () => void;
  onSelect: () => void;
}) => {
  const { column, index, kind } = row;
  const isColumn = kind === "column" && column;
  const relation = kind === "relation" ? column?.references : undefined;

  return (
    <button
      aria-level={2}
      className={cn(
        "group relative flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md pr-2 pl-11 text-left outline-none",
        "before:absolute before:top-0 before:bottom-0 before:left-[18px] before:w-px before:bg-border/60",
        "after:absolute after:top-1/2 after:left-[18px] after:h-px after:w-3 after:bg-border/60",
        "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-muted"
      )}
      data-active={active ? "true" : undefined}
      data-tree-id={treeId}
      onClick={onSelect}
      onFocus={onFocus}
      role="treeitem"
      tabIndex={tabIndex}
      type="button"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/65">
        {column?.primaryKey ? (
          <HugeiconsIcon
            aria-label="Primary key"
            className="size-3.5 text-primary"
            icon={Key01Icon}
            strokeWidth={2}
          />
        ) : null}
        {kind === "index" ? (
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3"
            icon={HashIcon}
            strokeWidth={2}
          />
        ) : null}
        {kind === "relation" ? (
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3"
            icon={Link01Icon}
            strokeWidth={2}
          />
        ) : null}
      </span>

      {isColumn ? (
        <>
          <code className="min-w-0 truncate bg-transparent p-0 text-foreground/90 text-xs">
            <Match query={query}>{column.name}</Match>
          </code>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {column.references ? <Constraint>FK</Constraint> : null}
            {column.unique && !column.primaryKey ? (
              <Constraint>UNIQUE</Constraint>
            ) : null}
            {column.nullable ? <Constraint>NULL</Constraint> : null}
            <code className="w-20 truncate bg-transparent p-0 text-right text-[11px] text-muted-foreground">
              <Match query={query}>{column.type}</Match>
            </code>
          </span>
        </>
      ) : null}

      {index ? (
        <>
          <code className="min-w-0 truncate bg-transparent p-0 text-foreground/80 text-[11px]">
            <Match query={query}>{index.name}</Match>
          </code>
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            {index.unique ? <Constraint>UNIQUE</Constraint> : null}
            <code className="max-w-28 truncate bg-transparent p-0 text-[10px] text-muted-foreground">
              {index.columns.join(", ")}
            </code>
          </span>
        </>
      ) : null}

      {relation && column ? (
        <>
          <code className="min-w-0 truncate bg-transparent p-0 text-foreground/80 text-[11px]">
            {column.name}
          </code>
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground/50"
            icon={ArrowRight01Icon}
            strokeWidth={2}
          />
          <code className="min-w-0 truncate bg-transparent p-0 text-[11px] text-muted-foreground">
            {relation.table}.{relation.column}
          </code>
        </>
      ) : null}
    </button>
  );
};

const LoadingTree = () => (
  <output
    aria-label="Loading schema"
    className="block min-h-0 flex-1 space-y-1 overflow-hidden p-2"
  >
    {[72, 58, 84, 64].map((width) => (
      <div className="flex h-10 items-center gap-2 px-2" key={width}>
        <span className="size-3.5 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        <span className="size-6 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <span
          className="h-3 animate-pulse rounded bg-muted motion-reduce:animate-none"
          style={{ width }}
        />
      </div>
    ))}
  </output>
);

export type SchemaExplorerProps = Omit<ComponentProps<"div">, "children"> & {
  tables: Table[];
  /** Expanded table names when controlled. */
  expanded?: string[];
  /** Table names expanded on first render. */
  defaultExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
  onColumnSelect?: (table: Table, column: Column) => void;
  onIndexSelect?: (table: Table, index: Index) => void;
  /** Fork (D84). A per-table action, drawn at the row's right-hand end. */
  onTableAction?: (table: Table) => void;
  /**
   * Fork (D84). Its accessible name, per table — the button is an icon, so
   * this is the only name it has, and it is a function because the string
   * that reads well names the table it acts on.
   */
  tableActionLabel?: (table: Table) => string;
  /**
   * Fork (D84). Rendered in the header in place of `title`, for a caller
   * whose header line is a control rather than a label.
   */
  titleSlot?: ReactNode;
  title?: string;
  isLoading?: boolean;
};

export const SchemaExplorer = ({
  tables,
  expanded,
  defaultExpanded,
  onExpandedChange,
  onColumnSelect,
  onIndexSelect,
  onTableAction,
  tableActionLabel = (table) => `Run a query on ${table.name}`,
  titleSlot,
  title = "public",
  isLoading = false,
  className,
  ...props
}: SchemaExplorerProps) => {
  const controlled = expanded !== undefined;
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(
    () => new Set(defaultExpanded)
  );
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(() =>
    tables[0] ? `table:${tables[0].name}` : ""
  );
  const typeahead = useRef("");
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const openTables = useMemo(
    () => (controlled ? new Set(expanded) : uncontrolledExpanded),
    [controlled, expanded, uncontrolledExpanded]
  );
  const normalizedQuery = normalize(query);
  const rows = useMemo(
    () => getVisibleRows(tables, openTables, normalizedQuery),
    [tables, openTables, normalizedQuery]
  );
  const tableCount = rows.filter((row) => row.kind === "table").length;
  const [firstRow] = rows;
  const resolvedActiveId = rows.some((row) => row.id === activeId)
    ? activeId
    : (firstRow?.id ?? "");

  useEffect(
    () => () => {
      if (typeaheadTimer.current) {
        clearTimeout(typeaheadTimer.current);
      }
    },
    []
  );

  const setOpenTables = (next: Set<string>) => {
    if (!controlled) {
      setUncontrolledExpanded(next);
    }
    onExpandedChange?.([...next]);
  };

  const toggleTable = (name: string, force?: boolean) => {
    const next = new Set(openTables);
    const shouldOpen = force ?? !next.has(name);
    if (shouldOpen) {
      next.add(name);
    } else {
      next.delete(name);
    }
    setOpenTables(next);
  };

  const activateTable = (name: string) => {
    if (normalizedQuery) {
      setQuery("");
      toggleTable(name, true);
      return;
    }
    toggleTable(name);
  };

  const focusRow = (id: string) => {
    setActiveId(id);
    requestAnimationFrame(() => {
      treeRef.current
        ?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)
        ?.focus();
    });
  };

  const navigateByOffset = (index: number, offset: number) => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + offset))];
    if (next) {
      focusRow(next.id);
    }
  };

  const handleHorizontalKey = (
    event: KeyboardEvent<HTMLDivElement>,
    active: TreeRow,
    index: number
  ) => {
    if (event.key === "ArrowRight" && active.kind === "table") {
      event.preventDefault();
      if (openTables.has(active.table.name) || normalizedQuery) {
        const firstChild = rows[index + 1];
        if (firstChild?.table.name === active.table.name) {
          focusRow(firstChild.id);
        }
      } else {
        toggleTable(active.table.name, true);
      }
      return true;
    }
    if (event.key !== "ArrowLeft") {
      return false;
    }
    event.preventDefault();
    if (active.kind === "table" && openTables.has(active.table.name)) {
      toggleTable(active.table.name, false);
    } else if (active.kind !== "table") {
      focusRow(`table:${active.table.name}`);
    }
    return true;
  };

  const handleTypeahead = (
    event: KeyboardEvent<HTMLDivElement>,
    index: number
  ) => {
    if (
      event.key.length !== 1 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    typeahead.current += event.key.toLowerCase();
    if (typeaheadTimer.current) {
      clearTimeout(typeaheadTimer.current);
    }
    typeaheadTimer.current = setTimeout(() => {
      typeahead.current = "";
    }, 500);
    const ordered = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
    const match = ordered.find((row) => {
      const label = row.column?.name ?? row.index?.name ?? row.table.name;
      return label.toLowerCase().startsWith(typeahead.current);
    });
    if (match) {
      focusRow(match.id);
    }
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.id === resolvedActiveId);
    const active = rows[index];
    if (!active) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      navigateByOffset(index, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const edge = event.key === "Home" ? rows[0] : rows.at(-1);
      focusRow(edge?.id ?? active.id);
      return;
    }
    if (handleHorizontalKey(event, active, index)) {
      return;
    }
    if (
      (event.key === "Enter" || event.key === " ") &&
      active.kind === "table"
    ) {
      event.preventDefault();
      activateTable(active.table.name);
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
    handleTypeahead(event, index);
  };

  return (
    <div
      className={cn(
        // Fork (D87). `flex flex-col` and nothing else: the height comes
        // from the caller, and with none the column is as tall as its rows.
        "@container flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card shadow-xs",
        className
      )}
      data-slot="schema-explorer"
      {...props}
    >
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-border/60 border-b px-3">
        <span className="grid size-6 place-items-center rounded-md bg-primary/10 text-primary">
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3.5"
            icon={Database01Icon}
            strokeWidth={2}
          />
        </span>
        {/* Fork (D84). With a `titleSlot` the header is a control and the
            count moves beside it; without one it is the registry's own
            two-line block. The `/ to search` hint that used to sit on the
            right is gone: the search field is permanently visible a row
            below, so the hint bought nothing but the misleading half of the
            truth -- the key only works from inside the tree, which it did not
            say. The shortcut itself is untouched. */}
        {titleSlot ? (
          <>
            <div className="min-w-0 flex-1">{titleSlot}</div>
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {tables.length} {tables.length === 1 ? "table" : "tables"}
            </span>
          </>
        ) : (
          <div className="min-w-0">
            <p className="truncate font-medium text-xs">{title}</p>
            <p className="text-[10px] text-muted-foreground">
              {tables.length} {tables.length === 1 ? "table" : "tables"}
            </p>
          </div>
        )}
      </header>

      <label className="flex h-10 shrink-0 items-center gap-2 border-border/60 border-b px-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/40">
        <HugeiconsIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
          icon={Search01Icon}
          strokeWidth={2}
        />
        <input
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/65"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a table, column, or type"
          ref={searchRef}
          type="search"
          value={query}
        />
        {query ? (
          <>
            <span
              aria-live="polite"
              className="text-[10px] text-muted-foreground tabular-nums"
            >
              {tableCount} {tableCount === 1 ? "table" : "tables"}
            </span>
            <button
              aria-label="Clear search"
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.96] motion-reduce:active:scale-100"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              type="button"
            >
              <HugeiconsIcon
                aria-hidden="true"
                className="size-3"
                icon={Cancel01Icon}
                strokeWidth={2}
              />
            </button>
          </>
        ) : null}
      </label>

      {isLoading ? <LoadingTree /> : null}

      {!isLoading && rows.length > 0 ? (
        <div
          aria-label={`${title} database schema`}
          // Fork (D87). Was `max-h-96`. `min-h-0` is what makes the scroll
          // happen in here rather than in the page: a flex item's default
          // `min-height: auto` refuses to shrink below its content.
          className="neon-scroll-fade min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5"
          onKeyDown={onTreeKeyDown}
          ref={treeRef}
          role="tree"
          tabIndex={-1}
        >
          {rows.map((row) => {
            const active = row.id === resolvedActiveId;
            const common = {
              active,
              onFocus: () => setActiveId(row.id),
              query: normalizedQuery,
              tabIndex: active ? 0 : -1,
            };
            return (
              <div key={row.id} role="none">
                {row.kind === "table" ? (
                  <TableRow
                    {...common}
                    actionLabel={
                      onTableAction ? tableActionLabel(row.table) : undefined
                    }
                    onAction={
                      onTableAction
                        ? () => onTableAction(row.table)
                        : undefined
                    }
                    onToggle={() => activateTable(row.table.name)}
                    open={
                      openTables.has(row.table.name) || Boolean(normalizedQuery)
                    }
                    table={row.table}
                    treeId={row.id}
                  />
                ) : (
                  <LeafRow
                    {...common}
                    onSelect={() => {
                      if (row.kind === "column" && row.column) {
                        onColumnSelect?.(row.table, row.column);
                      }
                      if (row.kind === "index" && row.index) {
                        onIndexSelect?.(row.table, row.index);
                      }
                    }}
                    row={row}
                    treeId={row.id}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {!isLoading && rows.length === 0 ? (
        <div className="grid min-h-36 flex-1 place-items-center px-6 py-8 text-center">
          <div>
            <div className="mx-auto mb-2 grid size-8 place-items-center rounded-lg border border-border/60 bg-background shadow-xs">
              <HugeiconsIcon
                aria-hidden="true"
                className="size-3.5 text-muted-foreground"
                icon={Search01Icon}
                strokeWidth={2}
              />
            </div>
            <p className="font-medium text-xs">No schema objects found</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Try a table, column, or Postgres type.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
};
