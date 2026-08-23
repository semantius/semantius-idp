/**
 * The mailer: templates + transport, with the FR-MAIL-2 degraded-mode rule in
 * one place.
 *
 * Callers ask for a named message and a recipient; whether anything is
 * actually sent is this module's decision, not theirs. That is what keeps
 * "e-mail is off" from being a condition repeated at every call site — and
 * from being forgotten at one of them.
 *
 * Delivery failures never propagate to the user's request: a sign-up that
 * succeeded must not report failure because Resend had a bad minute. The
 * failure is logged and audited instead.
 */

import type { IdpConfig } from "../config/derive"
import { getCatalog } from "../i18n"
import type { Catalog } from "../i18n"
import type { Logger } from "../logger"
import { templates } from "./templates"
import {
  createCaptureTransport,
  createDisabledTransport,
  createResendTransport,
} from "./transport"
import type { CaptureTransport, EmailTransport } from "./transport"

export interface Mailer {
  readonly enabled: boolean
  readonly transport: EmailTransport
  /** Sends one templated message. Never throws. */
  send: <TName extends keyof typeof templates>(
    name: TName,
    to: string,
    ...args: TemplateArgs<TName>
  ) => Promise<void>
}

/** The extra arguments a template needs beyond its context, if any. */
type TemplateArgs<TName extends keyof typeof templates> =
  Parameters<(typeof templates)[TName]> extends [unknown, infer Input]
    ? [input: Input]
    : []

export interface CreateMailerOptions {
  config: IdpConfig
  logger: Logger
  /** Overrides the transport. Tests and the e2e image pass a capture transport. */
  transport?: EmailTransport
  /** Locale for the message. Defaults to `site.defaultLocale`. */
  locale?: string
}

export function createMailer(options: CreateMailerOptions): Mailer {
  const { config, logger } = options
  const transport = options.transport ?? defaultTransport(config, logger)
  const enabled = transport.kind !== "disabled"

  return {
    enabled,
    transport,
    send: async (name, to, ...args) => {
      if (!enabled) {
        // FR-MAIL-2: nothing is sent, and the affected UI is hidden anyway.
        logger.debug("e-mail suppressed: degraded mode", {
          template: String(name),
        })
        return
      }

      try {
        const t: Catalog = getCatalog(
          options.locale ?? config.file.site.defaultLocale
        )
        const build = templates[name] as (
          context: { config: IdpConfig; t: Catalog },
          input?: unknown
        ) => { subject: string; html: string; text: string; template: string }
        const message = build({ config, t }, args[0])
        await transport.send({ ...message, to })
        logger.debug("e-mail sent", { template: message.template })
      } catch (error) {
        // Never fail the user's request because delivery failed.
        logger.error("e-mail could not be sent", {
          template: String(name),
          err: error,
        })
      }
    },
  }
}

function defaultTransport(config: IdpConfig, logger: Logger): EmailTransport {
  const apiKey = config.file.email.resend.apiKey
  const from = config.file.email.from
  if (!apiKey || !from) return createDisabledTransport(logger)

  return createResendTransport({
    apiKey,
    from,
    replyTo: config.file.email.replyTo,
    logger,
  })
}

/**
 * Convenience for tests and the e2e image: a mailer whose transport can be
 * inspected.
 *
 * It still honours degraded mode. A capture mailer that sent regardless would
 * make FR-MAIL-2 untestable — the one behaviour where "nothing is sent" is the
 * requirement.
 */
export function createCaptureMailer(
  config: IdpConfig,
  logger: Logger
): Mailer & { captured: CaptureTransport } {
  const captured = createCaptureTransport()
  const transport = config.emailEnabled
    ? captured
    : createDisabledTransport(logger)
  const mailer = createMailer({ config, logger, transport })
  return Object.assign(mailer, { captured })
}
