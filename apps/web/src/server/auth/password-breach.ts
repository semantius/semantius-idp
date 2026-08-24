/**
 * Refusing passwords that are already in a breach corpus (FR-AUTH-1, SEC-8).
 *
 * `auth.password.breachCheck` has been in the configuration schema since M2
 * and has never done anything. This is what it does.
 *
 * **The password never leaves this process.** The check is Have I Been Pwned's
 * k-anonymity range API: SHA-1 the password, send the *first five hex
 * characters* of the digest, and get back every suffix that shares that
 * prefix — some eight hundred of them — with a count each. The comparison
 * happens here. The service learns that somebody, somewhere, has a password
 * whose hash starts with those five characters, which is true of roughly one
 * in a million of every password in existence.
 *
 * SHA-1 is not a mistake here. It is the corpus's index, not a security
 * decision, and it is never stored.
 *
 * **Turning this on adds one egress origin** — `api.pwnedpasswords.com` — to a
 * deployment that otherwise talks to nothing but its database and, optionally,
 * Resend. That is why it is off by default and why DOC-4 has to say so: an
 * operator running in a network with no outbound access needs to know that
 * enabling this makes every sign-up depend on reaching the internet.
 *
 * **A failure never blocks a password.** If the service is slow, down, or
 * unreachable, the password is accepted and the failure is logged. The
 * alternative is a deployment where nobody can register because a third party
 * is having a bad day — and the check is a hardening measure, not an
 * authentication step.
 */

import { createHash } from "node:crypto"

import type { Logger } from "../logger"

const RANGE_ENDPOINT = "https://api.pwnedpasswords.com/range"

/**
 * How long to wait before giving up and letting the password through.
 *
 * Short on purpose: this sits in front of a form submission, and three seconds
 * of a spinner is already the difference between "signed up" and "gave up".
 */
const DEFAULT_TIMEOUT_MS = 3000

export interface BreachCheckDeps {
  logger?: Logger
  /** Injected by tests; production uses the global. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}

export interface BreachResult {
  /** True when the corpus has seen this password. */
  breached: boolean
  /** How many times, when known. Never shown to the user. */
  count?: number
  /** True when the service could not be reached and the password was allowed. */
  unavailable?: boolean
}

/**
 * Whether this password appears in the corpus.
 *
 * Returns `{ breached: false, unavailable: true }` rather than throwing when
 * the service cannot be reached — the caller must not be able to tell the
 * difference between "not breached" and "could not check" without asking.
 */
export async function checkPasswordBreach(
  password: string,
  deps: BreachCheckDeps = {}
): Promise<BreachResult> {
  if (password === "") return { breached: false }

  const digest = createHash("sha1")
    .update(password, "utf8")
    .digest("hex")
    .toUpperCase()
  const prefix = digest.slice(0, 5)
  const suffix = digest.slice(5)

  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )

  try {
    const response = await fetchImpl(`${RANGE_ENDPOINT}/${prefix}`, {
      // Padding asks the service to return a random number of decoy hashes, so
      // the *response size* stops being a signal about the prefix either.
      headers: { "Add-Padding": "true" },
      signal: controller.signal,
    })
    if (!response.ok) {
      deps.logger?.warn("password breach check unavailable", {
        status: response.status,
      })
      return { breached: false, unavailable: true }
    }

    const body = await response.text()
    const count = findSuffix(body, suffix)
    // A padded response includes decoys with a count of zero; a real hit never
    // has one, so zero means "this is padding" and not "seen zero times".
    return count > 0 ? { breached: true, count } : { breached: false }
  } catch (error) {
    deps.logger?.warn("password breach check failed; allowing the password", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { breached: false, unavailable: true }
  } finally {
    clearTimeout(timer)
  }
}

/** Finds `suffix:count` in the range response. Returns 0 when absent. */
function findSuffix(body: string, suffix: string): number {
  for (const line of body.split("\n")) {
    const separator = line.indexOf(":")
    if (separator === -1) continue
    if (line.slice(0, separator).trim().toUpperCase() !== suffix) continue
    const count = Number.parseInt(line.slice(separator + 1).trim(), 10)
    return Number.isFinite(count) ? count : 0
  }
  return 0
}
