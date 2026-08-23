/**
 * E-mail transport (FR-MAIL-1/2).
 *
 * Exactly two implementations in v1, behind one interface:
 *
 * - **`resend`** — the real one.
 * - **`capture`** — keeps messages in memory. Used by tests and by the e2e run
 *   against the built image, which reads the verification and reset links back
 *   out through a test-only endpoint rather than parsing a mailbox.
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
  /** Injected by tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
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

/** In-memory transport for tests and the e2e run. */
export function createCaptureTransport(): CaptureTransport {
  const messages: EmailMessage[] = []
  return {
    kind: "capture",
    messages,
    send: async (message) => {
      messages.push(message)
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
