/**
 * The display name, derived rather than typed (FR-SIGNUP-5, **D49**).
 *
 * `user.name` is a Better-Auth-fixed column and every claim builder, e-mail
 * template and admin table reads it — but nobody should be *editing* it. Two
 * people who type "Jane Smith" and "Smith, Jane" into a free-text field produce
 * a user list that cannot be sorted and a `name` claim that means two different
 * things. So first and last name are what is captured, everywhere, and this is
 * the one place that turns them into the string those readers see.
 *
 * `site.nameFormat` chooses between the two orders. It is a rendering decision
 * and nothing else: the parts are stored as parts, so changing the setting and
 * re-saving a profile re-derives the name without losing anything.
 *
 * Missing parts collapse rather than leaving punctuation behind — "Smith, "
 * with nothing after the comma is worse than "Smith". Both empty returns `""`,
 * and the caller decides what to show instead (usually the e-mail address,
 * which is the only thing every account is guaranteed to have).
 */

export type NameFormat = "first-last" | "last-first"

export function displayName(
  first: string | null | undefined,
  last: string | null | undefined,
  format: NameFormat = "first-last"
): string {
  const given = (first ?? "").trim()
  const family = (last ?? "").trim()

  if (given === "" && family === "") return ""
  if (given === "") return family
  if (family === "") return given

  return format === "last-first" ? `${family}, ${given}` : `${given} ${family}`
}
