/**
 * The one-time set-password link an administrator is handed (**D65**).
 *
 * It travels through the server-side one-shot stash rather than the URL — a
 * link that grants a password reset does not belong in browser history — and
 * what is stashed is now `{url, email}` rather than a bare URL, because the
 * dialog showing it has to say *whose* account it is for. An administrator who
 * has just created two accounts has two identical-looking links otherwise.
 *
 * Parsed here rather than in the loader's server function, so the shape is one
 * pure function both sides agree on and neither has to guess at a bare string
 * left over from an older stash.
 */

export interface InviteLink {
  url: string
  email?: string
}

export function parseInviteLink(value: string | null): InviteLink | undefined {
  if (!value) return undefined
  // A stash written before D65, or by anything else, is a bare URL. Treated as
  // one rather than discarded: the link still works, it is only unlabelled.
  if (!value.startsWith("{")) return { url: value }
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.url !== "string") return undefined
    return {
      url: record.url,
      email: typeof record.email === "string" ? record.email : undefined,
    }
  } catch {
    return undefined
  }
}
