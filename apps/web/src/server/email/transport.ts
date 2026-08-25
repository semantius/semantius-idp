/**
 * E-mail transport (FR-MAIL-1/2).
 *
 * Exactly two implementations in v1, behind one interface:
 *
 * - **`resend`** — the real one.
 * - **`capture`** — keeps messages in memory, and optionally writes each one to
 *   a directory as JSON (**D30**). The in-memory half is what the integration
 *   suite asserts against; the files are how the e2e run reads a verification
 *   or reset link out of the **built image**, where there is no in-process
 *   handle to reach for.
 *
 * D30 chose files over an HTTP endpoint deliberately. An endpoint that returns
 * captured mail is an endpoint that returns password-reset links, and it would
 * exist in the shipped image — one misconfiguration away from being the worst
 * possible disclosure (SEC-10). A directory that only exists when
 * `IDP_EMAIL_TRANSPORT=capture` is set, under the image's only writable path,
 * has no such reachable surface.
 *
 * No SMTP in v1. When no API key is configured the IdP runs in **degraded
 * mode**: nothing is sent, the affected UI is hidden, and
 * `auth.requireEmailVerification` is forced false — so `send()` is never called
 * on a path the user can reach. The null transport exists so the code that
 * would send does not have to be conditional everywhere.
 */

import type { Logger } from "../logger"

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
  /** Set by the caller so a failure names what was being sent. */
  template: string
}

export interface EmailTransport {
  readonly kind: "resend" | "capture" | "disabled"
  /** Resolves when the message has been handed off. Throws on a real failure. */
  send: (message: EmailMessage) => Promise<void>
}

export interface CaptureTransport extends EmailTransport {
  readonly kind: "capture"
  readonly messages: readonly EmailMessage[]
  /** Messages sent to one address, newest last. */
  for: (email: string) => EmailMessage[]
  /** The most recent message, optionally filtered by template. */
  last: (template?: string) => EmailMessage | undefined
  clear: () => void
}

export interface ResendTransportOptions {
  apiKey: string
  from: string
  replyTo?: string
  logger: Logger
  /**
   * Injected by tests. Defaults to the global `fetch`.
   *
   * Typed as the call signature rather than `typeof fetch` so a stub only has
   * to be callable — the runtime's `fetch` carries extra members (Bun adds
   * `preconnect`) that no caller here uses.
   */
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const RESEND_ENDPOINT = "https://api.resend.com/emails"

/**
 * Resend over its REST API rather than the SDK: one `fetch` against a
 * documented endpoint is less surface than a client library, and SEC-8 wants
 * the runtime's external dependencies countable.
 */
export function createResendTransport(
  options: ResendTransportOptions
): EmailTransport {
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    kind: "resend",
    send: async (message) => {
      const response = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(options.replyTo ? { reply_to: options.replyTo } : {}),
        }),
      })

      if (!response.ok) {
        // The body can echo the recipient; keep it out of the thrown message,
        // which may be logged (SEC-5).
        const detail = await response.text().catch(() => "")
        options.logger.error("e-mail delivery failed", {
          template: message.template,
          status: response.status,
          detail: detail.slice(0, 200),
        })
        throw new Error(
          `Resend rejected the ${message.template} e-mail with status ${response.status}.`
        )
      }
    },
  }
}

export interface CaptureTransportOptions {
  /**
   * Also write each message here as JSON (D30). Absent for the integration
   * suite, which reads `messages` directly.
   */
  directory?: string
  /** A failed write is logged, never thrown — see `send` below. */
  logger?: Logger
  /** Injected by tests so no file is touched. */
  writeFile?: (path: string, contents: string) => Promise<void>
  /** Injected by tests. */
  mkdir?: (path: string) => Promise<void>
}

/** Filename-safe, ordered, and unique within a run. */
let captureSequence = 0

/** In-memory transport for tests and the e2e run. */
export function createCaptureTransport(
  options: CaptureTransportOptions = {}
): CaptureTransport {
  const messages: EmailMessage[] = []
  const write = options.directory ? fileWriter(options) : undefined

  return {
    kind: "capture",
    messages,
    send: async (message) => {
      messages.push(message)
      // **After the push, and never allowed to fail the send.** The in-memory
      // record is the contract every existing caller relies on; the file is an
      // extra for a test harness in another process. A full disk in a
      // container's tmpfs must not turn "the e-mail was sent" into an error
      // the user sees.
      if (write) await write(message)
    },
    for: (email) =>
      messages.filter(
        (message) => message.to.toLowerCase() === email.toLowerCase()
      ),
    last: (template) => {
      const candidates = template
        ? messages.filter((message) => message.template === template)
        : messages
      return candidates.at(-1)
    },
    clear: () => {
      messages.length = 0
    },
  }
}

/**
 * Degraded mode (FR-MAIL-2). Sending is a no-op that logs, because reaching it
 * means a code path forgot to check `emailEnabled` — worth noticing, not worth
 * failing a request over.
 */
export function createDisabledTransport(logger: Logger): EmailTransport {
  return {
    kind: "disabled",
    send: async (message) => {
      logger.warn("e-mail not sent: no transport is configured", {
        template: message.template,
      })
    },
  }
}

/**
 * Writes one captured message per file, as JSON.
 *
 * The name is `<sequence>-<template>-<recipient>.json`, which is sortable by
 * arrival and greppable by both of the things a test looks a message up by.
 * The recipient is sanitised rather than encoded: this builds a path, and the
 * only characters that survive are ones that cannot leave the directory.
 */
function fileWriter(
  options: CaptureTransportOptions
): (message: EmailMessage) => Promise<void> {
  const directory = options.directory!
  let ready: Promise<void> | undefined

  const mkdir =
    options.mkdir ??
    (async (path: string) => {
      const { mkdir: make } = await import("node:fs/promises")
      await make(path, { recursive: true })
    })
  const writeFile =
    options.writeFile ??
    (async (path: string, contents: string) => {
      const { writeFile: write } = await import("node:fs/promises")
      await write(path, contents, "utf8")
    })

  return async (message) => {
    try {
      ready ??= mkdir(directory)
      await ready
      // Two steps, and the second is not redundant. Stripping the separators
      // is what stops the path escaping; collapsing runs of dots is what stops
      // the *filename* containing a literal `..`, which nothing here would act
      // on but plenty of tooling downstream reads as a traversal.
      const safeRecipient = message.to
        .replace(/[^a-zA-Z0-9._@-]/g, "_")
        .replace(/\.{2,}/g, ".")
      const name = `${String(++captureSequence).padStart(4, "0")}-${message.template}-${safeRecipient}.json`
      await writeFile(
        `${directory}/${name}`,
        JSON.stringify({ ...message, capturedAt: new Date().toISOString() }, null, 2)
      )
    } catch (error) {
      // A capture directory that cannot be written is a broken test harness,
      // not a broken deployment.
      options.logger?.warn("captured e-mail could not be written", {
        template: message.template,
        err: error,
      })
      // Reset so a transient failure does not poison every later message.
      ready = undefined
    }
  }
}
