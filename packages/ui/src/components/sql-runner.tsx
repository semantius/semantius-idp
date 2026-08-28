"use client";

/**
 * **A fork of ui.neon.com's `SQLRunner`, not registry output any more**
 * (D84), for the same reason `schema-explorer.tsx` beside it is: the schema
 * tree's run button has to put a statement in this editor *and execute it*,
 * and the registry component can be handed a `value` but not told to run.
 * Two divergences, marked `Fork (D84)` / `Fork (D87)` where they sit:
 *
 * 1. A `ref` exposing `run()` (**D84**).
 * 2. **The card fills its container and splits itself** (**D87**). The editor
 *    was 190 px of fixed CodeMirror and the grid `max-h-80`, so neither
 *    followed the window; both are panes of a vertical
 *    `ResizablePanelGroup` now, the editor opening at nine rows and
 *    scrolling past them, the grid taking whatever is left.
 *    **This makes a height-constrained parent a requirement**: a panel group
 *    measures its own box, and in an auto-height column it measures zero.
 *    `/admin/database` gives it one; anything else that mounts this has to.
 *
 * Re-running `shadcn add sql-runner` overwrites both.
 */

import { PostgreSQL, sql } from "@codemirror/lang-sql";
import {
  bracketMatching,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, Prec } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Database01Icon,
  Loading03Icon,
  PlayIcon,
  Shield01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { tags } from "@lezer/highlight";
import { minimalSetup } from "codemirror";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ComponentProps, Ref } from "react";

import { Button } from "@workspace/ui/components/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable";
import { cn } from "@workspace/ui/lib/utils";

export type SQLRunnerMode = "read" | "read-write";

export interface SQLField {
  name: string;
  /** Database type label, e.g. "uuid" or "timestamptz". */
  type?: string;
}

export type SQLRow = Record<string, unknown>;

export interface SQLResult {
  rows: SQLRow[];
  fields?: SQLField[];
  /** Total rows returned or affected. Defaults to rows.length. */
  rowCount?: number;
  /** Query duration. Measured by SQLRunner when omitted. */
  durationMs?: number;
  /** Postgres command tag, e.g. "SELECT", "UPDATE", or "CREATE TABLE". */
  command?: string;
}

export interface SQLRunnerError {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  line?: number;
  column?: number;
}

export interface SQLExecutionContext {
  mode: SQLRunnerMode;
  signal: AbortSignal;
}

const WRITE_KEYWORDS = new Set([
  "ALTER",
  "CALL",
  "CLUSTER",
  "COMMENT",
  "COPY",
  "CREATE",
  "DELETE",
  "DO",
  "DROP",
  "GRANT",
  "INSERT",
  "LOCK",
  "MERGE",
  "REFRESH",
  "REINDEX",
  "REVOKE",
  "SET",
  "TRUNCATE",
  "UPDATE",
  "VACUUM",
]);

const stripSQLNoise = (query: string) =>
  query
    .replaceAll(/--.*$/gmu, " ")
    .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
    .replaceAll(/'(?:''|[^'])*'/gu, "''")
    .replaceAll(/"(?:""|[^"])*"/gu, '""');

/** Conservative client-side guard. The database remains the authority. */
export const isWriteQuery = (query: string) => {
  const tokens =
    stripSQLNoise(query)
      .toUpperCase()
      .match(/[A-Z_]+/gu) ?? [];
  return tokens.some((token) => WRITE_KEYWORDS.has(token));
};

const toRunnerError = (error: unknown): SQLRunnerError => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return { message: "Query cancelled." };
  }
  if (error instanceof Error) {
    const source = error as Error & Partial<SQLRunnerError>;
    return {
      code: source.code,
      column: source.column,
      detail: source.detail,
      hint: source.hint,
      line: source.line,
      message: source.message,
    };
  }
  return { message: "The query failed. Check the SQL and try again." };
};

const formatDuration = (durationMs: number) => {
  if (durationMs < 1) {
    return "<1 ms";
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }
  return `${(durationMs / 1000).toFixed(2)} s`;
};

const formatCell = (value: unknown) => {
  if (value === null) {
    return "NULL";
  }
  if (value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const getColumns = (result: SQLResult): SQLField[] => {
  if (result.fields && result.fields.length > 0) {
    return result.fields;
  }
  const [firstRow] = result.rows;
  return firstRow
    ? Object.keys(firstRow).map((name): SQLField => ({ name }))
    : [];
};

const ModeControl = ({
  mode,
  onChange,
}: {
  mode: SQLRunnerMode;
  onChange: (mode: SQLRunnerMode) => void;
}) => (
  <fieldset className="flex h-7 items-center rounded-md border border-border/60 bg-background p-0.5">
    <legend className="sr-only">Query safety mode</legend>
    <button
      aria-pressed={mode === "read"}
      className={cn(
        "h-6 rounded-[4px] px-2 font-medium text-[11px] outline-none transition-colors",
        "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        mode === "read"
          ? "bg-muted text-foreground shadow-xs"
          : "text-muted-foreground"
      )}
      onClick={() => onChange("read")}
      type="button"
    >
      Read only
    </button>
    <button
      aria-pressed={mode === "read-write"}
      className={cn(
        "h-6 rounded-[4px] px-2 font-medium text-[11px] outline-none transition-colors",
        "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        mode === "read-write"
          ? "bg-[var(--status-scaling)]/15 text-[var(--status-scaling)] shadow-xs"
          : "text-muted-foreground"
      )}
      onClick={() => onChange("read-write")}
      type="button"
    >
      Read + write
    </button>
  </fieldset>
);

const EXTERNAL_UPDATE = Annotation.define<boolean>();

/**
 * Fork (D87). The editor pane's opening height, in pixels.
 *
 * **Nine rows plus the position bar, and every term is one of the numbers in
 * `editorTheme` below.** `.cm-scroller` is `lineHeight: 20px`, `.cm-content`
 * is `padding: 12px 0`, and the bar under the editor is `h-7`. Change any of
 * the three and change this with it — the arithmetic is written out rather
 * than folded into a literal for exactly that reason.
 */
const EDITOR_PANE_PX = 9 * 20 + 2 * 12 + 28;

/** Three rows, which is the least that is worth calling an editor. */
const MIN_EDITOR_PANE_PX = 3 * 20 + 2 * 12 + 28;

/** The results header plus a row of the grid, so the pane never reads empty. */
const MIN_RESULTS_PANE_PX = 36 + 60;

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "13px",
    // Fork (D87). Was `190px`. The pane above decides the height now, and
    // 100 % of a flex item whose size flex resolved is a definite one.
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--primary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor:
      "color-mix(in oklch, var(--primary) 16%, transparent) !important",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)",
    color: "var(--foreground)",
  },
  ".cm-content": {
    caretColor: "var(--primary)",
    padding: "12px 0",
  },
  ".cm-content ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 16%, transparent)",
    color: "var(--foreground)",
  },
  ".cm-editor": { minWidth: "0" },
  ".cm-gutters": {
    backgroundColor: "color-mix(in oklch, var(--muted) 22%, transparent)",
    borderRight:
      "1px solid color-mix(in oklch, var(--border) 55%, transparent)",
    color: "color-mix(in oklch, var(--muted-foreground) 55%, transparent)",
  },
  ".cm-line": { padding: "0 12px" },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "40px",
    padding: "0 10px 0 8px",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--destructive)",
    textUnderlineOffset: "3px",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "20px",
    overscrollBehavior: "contain",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-lg)",
    color: "var(--popover-foreground)",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    overflow: "hidden",
  },
});

const sqlHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { color: "var(--primary)", fontWeight: "600", tag: tags.keyword },
    { color: "var(--status-scaling)", tag: tags.string },
    {
      color: "var(--muted-foreground)",
      fontStyle: "italic",
      tag: tags.comment,
    },
    { color: "var(--foreground)", tag: [tags.name, tags.variableName] },
    {
      color: "var(--status-sleeping)",
      tag: [tags.number, tags.bool, tags.null],
    },
    { color: "var(--muted-foreground)", tag: tags.punctuation },
    { color: "var(--destructive)", tag: tags.invalid },
  ])
);

interface EditorPosition {
  column: number;
  line: number;
  selectedCharacters: number;
}

const Editor = ({
  value,
  onChange,
  onRun,
  onCancel,
  onPositionChange,
  error,
  running,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: (selection?: string) => void;
  onCancel: () => void;
  onPositionChange: (position: EditorPosition, selection: string) => void;
  error: SQLRunnerError | null;
  running: boolean;
  disabled: boolean;
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const onCancelRef = useRef(onCancel);
  const onPositionChangeRef = useRef(onPositionChange);
  const runningRef = useRef(running);
  const initialValueRef = useRef(value);
  const initialDisabledRef = useRef(disabled);

  useEffect(() => {
    onChangeRef.current = onChange;
    onRunRef.current = onRun;
    onCancelRef.current = onCancel;
    onPositionChangeRef.current = onPositionChange;
    runningRef.current = running;
  }, [onCancel, onChange, onPositionChange, onRun, running]);

  useEffect(() => {
    if (!mountRef.current) {
      return;
    }

    const reportSelection = (view: EditorView) => {
      const selection = view.state.selection.main;
      const line = view.state.doc.lineAt(selection.head);
      const selected = view.state.sliceDoc(selection.from, selection.to);
      onPositionChangeRef.current(
        {
          column: selection.head - line.from + 1,
          line: line.number,
          selectedCharacters: selection.to - selection.from,
        },
        selected
      );
    };

    const view = new EditorView({
      doc: initialValueRef.current,
      extensions: [
        minimalSetup,
        lineNumbers(),
        highlightActiveLineGutter(),
        bracketMatching(),
        highlightSelectionMatches(),
        lintGutter(),
        keymap.of(searchKeymap),
        sql({ dialect: PostgreSQL }),
        editorTheme,
        sqlHighlighting,
        placeholder("select * from users limit 20;"),
        EditorView.contentAttributes.of({
          "aria-label": "SQL query",
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: "false",
        }),
        editable.current.of(
          EditorView.editable.of(!initialDisabledRef.current)
        ),
        Prec.high(
          keymap.of([
            {
              key: "Mod-Enter",
              run: (currentView) => {
                if (runningRef.current) {
                  return true;
                }
                const selection = currentView.state.selection.main;
                const selected = currentView.state.sliceDoc(
                  selection.from,
                  selection.to
                );
                onRunRef.current(selected || undefined);
                return true;
              },
            },
            {
              key: "Escape",
              run: () => {
                if (!runningRef.current) {
                  return false;
                }
                onCancelRef.current();
                return true;
              },
            },
          ])
        ),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.transactions.some((transaction) =>
              transaction.annotation(EXTERNAL_UPDATE)
            )
          ) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.docChanged || update.selectionSet) {
            reportSelection(update.view);
          }
        }),
      ],
      parent: mountRef.current,
    });
    viewRef.current = view;
    reportSelection(view);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) {
      return;
    }
    view.dispatch({
      annotations: EXTERNAL_UPDATE.of(true),
      changes: { from: 0, insert: value, to: view.state.doc.length },
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!disabled)),
    });
  }, [disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    if (!error) {
      view.dispatch(setDiagnostics(view.state, []));
      return;
    }

    const lineNumber = Math.max(
      1,
      Math.min(error.line ?? 1, view.state.doc.lines)
    );
    const line = view.state.doc.line(lineNumber);
    const from = Math.min(
      line.to,
      line.from + Math.max(0, (error.column ?? 1) - 1)
    );
    const detail = [error.message, error.detail, error.hint]
      .filter(Boolean)
      .join("\n");
    view.dispatch(
      setDiagnostics(view.state, [
        {
          from,
          message: detail,
          severity: "error",
          source: error.code,
          to: Math.min(line.to, from + 1),
        },
      ])
    );
  }, [error]);

  return (
    // Fork (D87). Two flex rows deep so CodeMirror's `height: 100%` has
    // something definite to be 100 % of.
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div
        className="min-h-0 min-w-0 flex-1 [&_.cm-editor.cm-focused]:ring-2 [&_.cm-editor.cm-focused]:ring-inset [&_.cm-editor.cm-focused]:ring-ring/40"
        ref={mountRef}
      />
    </div>
  );
};

const ErrorPanel = ({ error }: { error: SQLRunnerError }) => (
  <div
    aria-live="assertive"
    className="border-destructive/30 border-t bg-destructive/5 px-3 py-2.5"
    data-slot="sql-runner-error"
  >
    <div className="flex gap-2">
      <HugeiconsIcon
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-destructive"
        icon={Alert02Icon}
        strokeWidth={2}
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="font-medium text-destructive text-xs">
            {error.message}
          </p>
          {error.code ? (
            <code className="text-[10px] text-destructive/70">
              {error.code}
            </code>
          ) : null}
          {error.line ? (
            <span className="text-[10px] text-muted-foreground">
              Line {error.line}
              {error.column ? `, column ${error.column}` : ""}
            </span>
          ) : null}
        </div>
        {error.detail ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {error.detail}
          </p>
        ) : null}
        {error.hint ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Hint: {error.hint}
          </p>
        ) : null}
      </div>
    </div>
  </div>
);

const BlockedWrite = ({ onEnable }: { onEnable: () => void }) => (
  <div
    aria-live="polite"
    className="flex flex-wrap items-center gap-2 border-[var(--status-scaling)]/30 border-t bg-[var(--status-scaling)]/5 px-3 py-2"
  >
    <HugeiconsIcon
      aria-hidden="true"
      className="size-3.5 shrink-0 text-[var(--status-scaling)]"
      icon={Shield01Icon}
      strokeWidth={2}
    />
    <p className="min-w-48 flex-1 text-[11px] text-muted-foreground">
      This statement can change data. Read-only mode stopped it before
      execution.
    </p>
    <Button onClick={onEnable} size="xs" variant="outline">
      Enable writes
    </Button>
  </div>
);

const ResultsGrid = ({ result }: { result: SQLResult }) => {
  const columns = getColumns(result);
  const rowCount = result.rowCount ?? result.rows.length;
  const hasRows = result.rows.length > 0;

  if (!hasRows) {
    return (
      <div className="grid min-h-32 flex-1 place-items-center px-5 py-8 text-center">
        <div>
          <span className="mx-auto mb-2 grid size-8 place-items-center rounded-full bg-primary/10 text-primary">
            <HugeiconsIcon
              aria-hidden="true"
              className="size-4"
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
            />
          </span>
          <p className="font-medium text-xs">
            {result.command ? `${result.command} complete` : "Query complete"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
            {rowCount} {rowCount === 1 ? "row" : "rows"} affected
          </p>
        </div>
      </div>
    );
  }

  return (
    // Fork (D87). Was `max-h-80`.
    <div className="neon-scroll-fade min-h-0 flex-1 overflow-auto">
      <table className="w-full min-w-max border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0_var(--border)]">
          <tr>
            <th className="w-10 bg-muted/20 px-2 py-2 text-right font-normal text-[10px] text-muted-foreground">
              #
            </th>
            {columns.map((column) => (
              <th className="min-w-28 px-3 py-2 font-medium" key={column.name}>
                <span className="block font-mono text-[11px]">
                  {column.name}
                </span>
                {column.type ? (
                  <span className="mt-0.5 block font-normal text-[9px] text-muted-foreground">
                    {column.type}
                  </span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr
              className="border-border/45 border-b last:border-b-0 hover:bg-muted/30"
              key={rowIndex}
            >
              <td className="bg-muted/10 px-2 py-2 text-right font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                {rowIndex + 1}
              </td>
              {columns.map((column) => {
                const value = row[column.name];
                const formatted = formatCell(value);
                return (
                  <td
                    className={cn(
                      "max-w-72 px-3 py-2 font-mono text-[11px] tabular-nums",
                      value === null
                        ? "text-muted-foreground/50 italic"
                        : "text-foreground/85"
                    )}
                    key={column.name}
                    title={formatted}
                  >
                    <span className="block truncate">{formatted}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** Fork (D84). What the `ref` hands back. */
export interface SQLRunnerHandle {
  /** Run what is in the editor, exactly as the Run button does. */
  run: () => void;
}

// `ref` is omitted from the div's own props and re-declared below: this
// component's ref is its handle, not its root element (fork, D84).
export type SQLRunnerProps = Omit<ComponentProps<"div">, "children" | "ref"> & {
  /** Fork (D84). Imperative access, for a caller that fills the editor. */
  ref?: Ref<SQLRunnerHandle>;
  /** Execute SQL. Throw an Error or SQLRunnerError-shaped error on failure. */
  onExecute: (
    query: string,
    context: SQLExecutionContext
  ) => Promise<SQLResult>;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  mode?: SQLRunnerMode;
  defaultMode?: SQLRunnerMode;
  onModeChange?: (mode: SQLRunnerMode) => void;
  title?: string;
  database?: string;
  disabled?: boolean;
};

// oxlint-disable-next-line eslint/complexity -- explicit runner states stay co-located for honest precedence
export const SQLRunner = ({
  ref,
  onExecute,
  value,
  defaultValue = "",
  onValueChange,
  mode,
  defaultMode = "read",
  onModeChange,
  title = "SQL editor",
  database = "neondb",
  disabled = false,
  className,
  ...props
}: SQLRunnerProps) => {
  const valueControlled = value !== undefined;
  const modeControlled = mode !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalMode, setInternalMode] = useState(defaultMode);
  const [status, setStatus] = useState<
    "idle" | "running" | "success" | "error" | "blocked" | "cancelled"
  >("idle");
  const [result, setResult] = useState<SQLResult | null>(null);
  const [error, setError] = useState<SQLRunnerError | null>(null);
  const [lastExecutedQuery, setLastExecutedQuery] = useState("");
  const [editorState, setEditorState] = useState<{
    position: EditorPosition;
    selection: string;
  }>({
    position: { column: 1, line: 1, selectedCharacters: 0 },
    selection: "",
  });
  const controllerRef = useRef<AbortController | null>(null);
  // Fork (D84). Filled in below, once `run` exists; see the handle.
  const latestRun = useRef<(selection?: string) => Promise<void>>(() =>
    Promise.resolve()
  );
  const query = valueControlled ? value : internalValue;
  const safetyMode = modeControlled ? mode : internalMode;
  const stale = Boolean(
    result && lastExecutedQuery && query !== lastExecutedQuery
  );

  const setQuery = (next: string) => {
    if (!valueControlled) {
      setInternalValue(next);
    }
    onValueChange?.(next);
    if (status === "error" || status === "blocked" || status === "cancelled") {
      setStatus(result ? "success" : "idle");
      setError(null);
    }
  };

  const setMode = (next: SQLRunnerMode) => {
    if (!modeControlled) {
      setInternalMode(next);
    }
    onModeChange?.(next);
    if (status === "blocked") {
      setStatus(result ? "success" : "idle");
    }
  };

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus("cancelled");
  };

  const run = async (selection?: string) => {
    const trimmed = selection?.trim() || query.trim();
    if (!trimmed) {
      setError({ message: "Enter a query to run." });
      setStatus("error");
      return;
    }
    if (safetyMode === "read" && isWriteQuery(trimmed)) {
      setError(null);
      setStatus("blocked");
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    setStatus("running");
    const startedAt = performance.now();

    try {
      const next = await onExecute(trimmed, {
        mode: safetyMode,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      setResult({
        ...next,
        durationMs: next.durationMs ?? performance.now() - startedAt,
      });
      setLastExecutedQuery(query);
      setStatus("success");
    } catch (caughtError) {
      if (controller.signal.aborted) {
        return;
      }
      setError(toRunnerError(caughtError));
      setStatus("error");
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  };

  // Fork (D84). **One handle for the component's whole life, reading `run`
  // through a ref.** Two things need that. A handle rebuilt every render
  // would close over a stale `query` unless it were rebuilt on every change,
  // and -- worse -- `useImperativeHandle` detaches and re-attaches on each
  // render, so a caller passing a *callback* ref would be called with null
  // and a new object endlessly. The ref is written during render on purpose:
  // it is the same value the JSX below is about to use.
  latestRun.current = run;
  useImperativeHandle(
    ref,
    () => ({
      run: () => {
        void latestRun.current();
      },
    }),
    []
  );

  return (
    <div
      className={cn(
        // Fork (D87). `flex flex-col`, and the height is the caller's.
        "@container flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card shadow-xs",
        className
      )}
      data-mode={safetyMode}
      data-slot="sql-runner"
      data-state={status}
      {...props}
    >
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-border/60 border-b px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3.5"
            icon={Database01Icon}
            strokeWidth={2}
          />
        </span>
        <div className="min-w-24 flex-1">
          <p className="truncate font-medium text-xs">{title}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {database}
          </p>
        </div>
        <ModeControl mode={safetyMode} onChange={setMode} />
        {status === "running" ? (
          <Button onClick={cancel} size="sm" variant="outline">
            <HugeiconsIcon
              data-icon="inline-start"
              icon={StopIcon}
              strokeWidth={2}
            />
            Cancel
          </Button>
        ) : (
          <Button
            disabled={disabled}
            onClick={() => run(editorState.selection)}
            size="sm"
          >
            <HugeiconsIcon
              data-icon="inline-start"
              icon={PlayIcon}
              strokeWidth={2}
            />
            {editorState.selection ? "Run selection" : "Run"}
            <kbd className="hidden rounded bg-primary-foreground/15 px-1 py-0.5 font-sans text-[9px] @[420px]:inline">
              ⌘↵
            </kbd>
          </Button>
        )}
      </header>

      {/* Fork (D87). The editor and the results are two panes of one
          vertical group rather than two fixed-height blocks. `EDITOR_PANE_PX`
          is nine rows of the editor plus the position bar under it, in
          pixels, because that is the unit the requirement is written in and
          `react-resizable-panels` takes one: a percentage would be nine rows
          at exactly one window height and some other number of rows at every
          other. Double-clicking the separator puts it back. */}
      <ResizablePanelGroup className="min-h-0 flex-1" orientation="vertical">
        <ResizablePanel
          className="flex min-h-0 flex-col"
          defaultSize={EDITOR_PANE_PX}
          // Fork (D87). **Nine rows stay nine rows when the window changes
          // size**, which is the requirement; the default here is
          // `preserve-relative-size`, and it made the editor 5 rows in a
          // short window and 13 in a tall one. The results pane keeps the
          // default and absorbs the difference -- a group must contain at
          // least one panel that does.
          groupResizeBehavior="preserve-pixel-size"
          minSize={MIN_EDITOR_PANE_PX}
        >
          <Editor
            disabled={disabled}
            error={error}
            onCancel={cancel}
            onChange={setQuery}
            onPositionChange={(position, selection) =>
              setEditorState({ position, selection })
            }
            onRun={run}
            running={status === "running"}
            value={query}
          />
          <div className="flex h-7 shrink-0 items-center gap-2 border-border/50 border-t bg-muted/15 px-3 text-[10px] text-muted-foreground tabular-nums">
            <span>Ln {editorState.position.line}</span>
            <span>Col {editorState.position.column}</span>
            {editorState.position.selectedCharacters > 0 ? (
              <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-primary">
                {editorState.position.selectedCharacters} selected
              </span>
            ) : null}
            <span className="ml-auto">PostgreSQL</span>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* The refusal panels moved *below* the separator with the results
            (D87): a run that ends in an error produces one instead of a grid,
            so it belongs in the pane the answer is read in — and above the
            separator it would eat the rows the operator just asked for nine
            of. */}
        <ResizablePanel
          className="flex min-h-0 flex-col"
          minSize={MIN_RESULTS_PANE_PX}
        >
          {status === "blocked" ? (
            <BlockedWrite onEnable={() => setMode("read-write")} />
          ) : null}
          {status === "error" && error ? <ErrorPanel error={error} /> : null}

          <div
            className="flex min-h-0 flex-1 flex-col"
            data-slot="sql-runner-results"
          >
            <div className="flex h-9 shrink-0 items-center gap-2 border-border/50 border-b px-3">
              <p className="font-medium text-[11px]">Results</p>
              <div
                aria-live="polite"
                className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground"
              >
                {stale ? (
                  <span className="rounded-sm bg-[var(--status-scaling)]/10 px-1.5 py-0.5 text-[var(--status-scaling)]">
                    Previous query
                  </span>
                ) : null}
                {status === "running" ? (
                  <span className="flex items-center gap-1">
                    <HugeiconsIcon
                      aria-hidden="true"
                      className="size-3 animate-spin motion-reduce:animate-none"
                      icon={Loading03Icon}
                      strokeWidth={2}
                    />
                    Running
                  </span>
                ) : null}
                {status === "cancelled" ? <span>Cancelled</span> : null}
                {result && status !== "running" ? (
                  <>
                    <span className="tabular-nums">
                      {result.rowCount ?? result.rows.length}{" "}
                      {(result.rowCount ?? result.rows.length) === 1
                        ? "row"
                        : "rows"}
                    </span>
                    {result.durationMs === undefined ? null : (
                      <span className="flex items-center gap-1 tabular-nums">
                        <HugeiconsIcon
                          aria-hidden="true"
                          className="size-3"
                          icon={Clock01Icon}
                          strokeWidth={2}
                        />
                        {formatDuration(result.durationMs)}
                      </span>
                    )}
                  </>
                ) : null}
              </div>
            </div>

            {result ? (
              <ResultsGrid result={result} />
            ) : (
              <div className="grid min-h-28 flex-1 place-items-center px-5 py-7 text-center">
                <div>
                  <p className="text-[11px] text-muted-foreground">
                    Run a query to see results.
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground/60">
                    Read-only mode blocks statements that can change data.
                  </p>
                </div>
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
