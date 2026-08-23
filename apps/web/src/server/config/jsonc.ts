/**
 * JSONC parsing for the config folder (CFG-1).
 *
 * Config files are parsed as JSONC — comments and trailing commas are allowed —
 * so operators can annotate the shipped `config.example/` files in place.
 * Parse failures are reported with file, line and column.
 */

import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import type { ParseError, ParseOptions } from "jsonc-parser"

import type { ConfigFileName, ConfigIssue } from "./errors"

const PARSE_OPTIONS: ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
  allowEmptyContent: false,
}

export interface JsoncParseResult {
  /** Parsed value, or `undefined` when the document could not be parsed. */
  value: unknown
  issues: ConfigIssue[]
}

/**
 * Parses JSONC text. Returns every syntax error found rather than throwing on
 * the first, matching the "all errors in one pass" rule of CFG-5.
 */
export function parseJsoncText(
  file: ConfigFileName,
  text: string
): JsoncParseResult {
  if (text.trim() === "") {
    return {
      value: undefined,
      issues: [{ file, pointer: "", message: "The file is empty." }],
    }
  }

  const errors: ParseError[] = []
  const value = parseJsonc(text, errors, PARSE_OPTIONS) as unknown

  if (errors.length > 0) {
    return {
      value: undefined,
      issues: errors.map((error) => {
        const { line, column } = offsetToLineColumn(text, error.offset)
        return {
          file,
          pointer: "",
          message: `${printParseErrorCode(error.error)} at line ${line}, column ${column}`,
          hint: "The file must be valid JSONC (JSON plus comments and trailing commas).",
        } satisfies ConfigIssue
      }),
    }
  }

  if (value === undefined) {
    return {
      value: undefined,
      issues: [{ file, pointer: "", message: "The file is empty." }],
    }
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      value: undefined,
      issues: [
        {
          file,
          pointer: "",
          message: `Expected a JSON object at the top level, received ${describe(value)}.`,
        },
      ],
    }
  }

  return { value, issues: [] }
}

/**
 * `$schema` is honoured for editor IntelliSense and is exempt from the
 * unknown-key rule (CFG-1). It is stripped before validation so that every
 * schema can keep `additionalProperties: false`.
 */
export function stripSchemaKey(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value
  if (!("$schema" in value)) return value
  const { $schema: _ignored, ...rest } = value as Record<string, unknown>
  return rest
}

function offsetToLineColumn(
  text: string,
  offset: number
): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return typeof value
}
