/**
 * What the user typed, kept across a refusal (**D62**).
 *
 * Every mutation here is a form POST answered by a 303 carrying a bare error
 * code (`auth-proxy.ts`), so a rejected form remounts empty: the dialog is
 * closed, the twelve fields are blank, and the only thing on screen is a
 * sentence about what was wrong with a value that is now gone. That is the
 * whole of the "my input is lost" class of findings.
 *
 * The carrier is the house one-shot stash — the same `verification`-backed,
 * single-use store the API keys, the client secret and the set-password link
 * already travel through. A draft is not a secret, but the argument for not
 * putting it in the URL is the same one `one-shot.ts` makes: a query string
 * survives in history, in `Referer` and in every proxy log in between, and a
 * form body is exactly the kind of thing that should not.
 *
 * **Passwords are never stashed.** Callers pass the fields they mean, and
 * {@link stashDraft} strips anything password- or secret-shaped anyway: the
 * store is a database table, and a mistyped form is not a reason to write a
 * credential into one. `PasswordField` has no `defaultValue` prop for the same
 * reason — restoring a password field is not a feature this is missing.
 */

import { claim, stash } from "./one-shot"

import type { Runtime } from "../runtime"

export type Draft = Record<string, string>

/**
 * Field names that never reach the store, whatever a caller passes.
 *
 * A belt to the caller's braces. The list is matched against the field name,
 * so `password`, `confirmPassword`, `currentPassword`, `clientSecret` and
 * `token` are all covered without anybody having to remember them.
 */
const NEVER_STASHED = /pass(word)?|secret|token|credential/i

/**
 * Ten kilobytes of form. Generous for a dozen inputs and two textareas of
 * URIs, and small enough that this cannot become a way to write arbitrary
 * bulk into `verification` — the routes that POST forms sit in front of no
 * rate limiter. Over the cap nothing is stashed and the refusal is reported
 * on its own, which is exactly the behavior that existed before drafts.
 */
const MAX_DRAFT_BYTES = 10_000

export interface StashDraftOptions {
  /**
   * How long the draft stays claimable. The default matches the one-shot
   * store's own; a flow that detours through a full re-authentication asks
   * for more (see `/admin/clients`, **D63**).
   */
  ttlSeconds?: number
}

/**
 * What of a submission is kept, as a pure function — the rule, without the
 * store, so the "no passwords" guarantee can be asserted without a database.
 *
 * A repeated field (a checkbox group) arrives as an array and is flattened one
 * per line, which is how the textareas travel too. Empty values are dropped:
 * an empty string restores nothing and only makes the row bigger.
 */
export function draftFields(
  fields: Record<string, string | string[] | undefined>
): Draft | undefined {
  const kept: Draft = {}
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (NEVER_STASHED.test(name)) continue
    const flat = Array.isArray(value) ? value.join("\n") : value
    if (flat === "") continue
    kept[name] = flat
  }
  if (Object.keys(kept).length === 0) return undefined
  if (JSON.stringify(kept).length > MAX_DRAFT_BYTES) return undefined
  return kept
}

/**
 * Stores the submitted fields and returns the handle that claims them, or
 * `undefined` when there is nothing worth keeping.
 */
export async function stashDraft(
  runtime: Runtime,
  fields: Record<string, string | string[] | undefined>,
  { ttlSeconds = 600 }: StashDraftOptions = {}
): Promise<string | undefined> {
  const kept = draftFields(fields)
  if (!kept) return undefined
  return stash(runtime, JSON.stringify(kept), { ttlSeconds })
}

/**
 * Claims a stashed draft, consuming it.
 *
 * Single-use, like everything in that store: a refusal that happens again
 * stashes again, so the handle in the address bar is never the one that is
 * still on screen. A malformed value answers `undefined` rather than throwing
 * — the worst case is the form the user already had.
 */
export async function claimDraft(
  runtime: Runtime,
  handle: string | undefined
): Promise<Draft | undefined> {
  const value = await claim(runtime, handle)
  if (value === undefined) return undefined
  return parseDraft(value)
}

/** The other half of {@link draftFields}, and equally testable on its own. */
export function parseDraft(value: string): Draft | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined
  const draft: Draft = {}
  for (const [name, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") draft[name] = entry
  }
  return draft
}

/** Appends `draft=<handle>` to a path, replacing any existing one. */
export function withDraft(path: string, handle: string | undefined): string {
  if (!handle) return path
  const [base, query = ""] = path.split("?")
  const params = new URLSearchParams(query)
  params.set("draft", handle)
  return `${base}?${params.toString()}`
}
