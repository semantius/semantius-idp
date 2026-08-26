import { useSyncExternalStore } from "react"

/**
 * A timestamp in the *browser's* locale and timezone (FR-I18N-1).
 *
 * The requirement has always said "dates render in the browser locale"; the
 * code was the deviation, in two different directions at once. The admin pages
 * sliced the ISO string and showed raw UTC in four different precisions; the
 * account pages ran `Intl` server-side against the *configured* locale, under
 * a comment asserting the opposite of the spec. Neither showed an operator in
 * Berlin the time they would see on their own clock.
 *
 * **Why not simply call `Intl` during render.** Server-side `Intl` is the
 * server's ICU, the server's timezone and the configured locale; the client's
 * is the visitor's. Formatting on both sides produces two different strings
 * for the same node and React tears the hydration. So the first paint is a
 * deterministic sliced-UTC string — labelled `UTC` wherever a time is shown,
 * so it is not mistaken for local — and a hydration gate swaps it for the real
 * thing.
 * `useSyncExternalStore` with a server snapshot of `false` is the smallest
 * correct gate: it is `false` through SSR and the hydration pass, and `true`
 * on the effect that follows, which is exactly when `Intl` becomes the
 * visitor's.
 *
 * The `datetime` fallback carries a ` UTC` suffix; the `date` one does not,
 * and cannot usefully — "2026-08-26 UTC" is a date that reads as a timezone
 * problem rather than a date. The cost is that a viewer west of UTC can see
 * tomorrow's date for the length of one hydration, on a field whose precision
 * is a day anyway. The full instant is in `title` and `dateTime` throughout.
 *
 * The full ISO value stays in `dateTime` (machine-readable) and in `title`
 * (hoverable) — which is where the seconds precision the admin pages used to
 * print inline now lives.
 */

/** Never changes: hydration happens once and the value is per-render-pass. */
const subscribe = () => () => {}
const getSnapshot = () => true
const getServerSnapshot = () => false

function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export type LocalTimeVariant = "date" | "datetime"

const OPTIONS: Record<LocalTimeVariant, Intl.DateTimeFormatOptions> = {
  date: { dateStyle: "medium" },
  datetime: { dateStyle: "medium", timeStyle: "short" },
}

export function LocalTime({
  iso,
  variant = "datetime",
}: {
  /** A UTC ISO-8601 timestamp, as every column in this database stores it. */
  iso: string
  variant?: LocalTimeVariant
}) {
  const hydrated = useHydrated()

  return (
    <time
      dateTime={iso}
      title={iso}
      // Belt-and-braces. `useSyncExternalStore` uses `getServerSnapshot`
      // *during* hydration, so the first client pass matches the server
      // byte-for-byte and there is nothing to warn about; the swap happens on
      // the render after. This costs nothing and covers the day somebody
      // "simplifies" the gate into a `useEffect`.
      suppressHydrationWarning
    >
      {hydrated ? format(iso, variant) : fallback(iso, variant)}
    </time>
  )
}

/**
 * Memoised per variant. `Intl.DateTimeFormat` is expensive to construct and an
 * audit page renders fifty of these; the browser's locale and timezone cannot
 * change without a reload, so one formatter per variant is all that is needed.
 */
const FORMATTERS = new Map<LocalTimeVariant, Intl.DateTimeFormat>()

function formatterFor(variant: LocalTimeVariant): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(variant)
  if (!formatter) {
    // `undefined` locale, not the configured one: the visitor's own, which is
    // also what picks up their timezone.
    formatter = new Intl.DateTimeFormat(undefined, OPTIONS[variant])
    FORMATTERS.set(variant, formatter)
  }
  return formatter
}

function format(iso: string, variant: LocalTimeVariant): string {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return iso
  return formatterFor(variant).format(value)
}

/** Deterministic on both sides, and honest about which zone it is in. */
function fallback(iso: string, variant: LocalTimeVariant): string {
  return variant === "date"
    ? iso.slice(0, 10)
    : `${iso.slice(0, 16).replace("T", " ")} UTC`
}
