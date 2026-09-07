/**
 * The known shipped defaults, plus the markers a placeholder secret carries.
 *
 * Values, not shapes: the shape checks (length, "came through a placeholder")
 * are passed by every shipped default, so the VALUE is checked against the
 * documented dev credentials of the reference stack and the words a
 * placeholder is written with. The list is short on purpose — it exists to
 * catch a copied example, not to judge password strength.
 *
 * One reader today, `cross-checks.ts`, which warns about `secret`, the
 * database password and a file-declared client secret,
 * because a client secret is stored as an unsalted digest and a placeholder
 * there is a credential anyone who read the example can present. A warning
 * and not a refusal, like the other two: an old development `.env` carries
 * `example-…` for the two example clients and must keep booting. The entropy
 * floor `clients-schema.ts` refuses on is a shape check, not this list, which
 * is why the list still lives in its own module rather than beside it.
 */

const SHIPPED_DEFAULT_VALUES: ReadonlySet<string> = new Set([
  "postgres",
  "devpassword",
])

export const SHIPPED_DEFAULT_MARKERS = [
  "change-me",
  "changeme",
  "dev-only",
  "example",
  "insecure",
] as const

export function looksLikeShippedSecret(value: string): boolean {
  const lower = value.toLowerCase()
  if (SHIPPED_DEFAULT_VALUES.has(lower)) return true
  return SHIPPED_DEFAULT_MARKERS.some((marker) => lower.includes(marker))
}
