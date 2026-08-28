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
  /** Injected by tests so D30's env switch can be exercised without setting it. */
  env?: Record<string, string | undefined>
}

export function createMailer(options: CreateMailerOptions): Mailer {
  const { config, logger } = options
  const transport =
    options.transport ?? defaultTransport(config, logger, options.env)
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

/**
 * Where captured mail is written when the capture transport is switched on.
 *
 * `/tmp` because it is the image's **only** writable path (OPS-1: read-only
 * root filesystem, `/config` mounted read-only). Overridable so a run outside a
 * container can put it somewhere it can reach.
 */
export const DEFAULT_CAPTURE_DIR = "/tmp/idp-mail"

/**
 * D30: `IDP_EMAIL_TRANSPORT=capture` swaps the real transport for one that
 * writes every message to disk instead of sending it.
 *
 * **Environment-only, and deliberately not a config-file setting** (CFG-3's
 * env-only class). A `config.jsonc` key would be a durable, copy-pasteable way
 * to turn a production deployment into one that silently swallows every
 * password-reset e-mail and writes it to a file. An environment variable is set
 * per-run by whoever starts the process, which is the blast radius this
 * deserves.
 *
 * It is honoured **only when e-mail would otherwise work**: with no Resend key
 * the deployment is in degraded mode (FR-MAIL-2), and capturing there would
 * make "nothing is sent" untestable — which is the one behaviour where nothing
 * being sent is the requirement.
 */
function captureFromEnvironment(
  config: IdpConfig,
  logger: Logger,
  env: Record<string, string | undefined>
): EmailTransport | undefined {
  if (env.IDP_EMAIL_TRANSPORT !== "capture") return undefined
  if (!config.emailEnabled) return undefined

  const directory = env.IDP_EMAIL_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR
  logger.warn("e-mail capture transport is active: nothing will be sent", {
    directory,
    hint: "Unset IDP_EMAIL_TRANSPORT to send e-mail normally.",
  })
  return createCaptureTransport({ directory, logger })
}

function defaultTransport(
  config: IdpConfig,
  logger: Logger,
  env: Record<string, string | undefined> = process.env
): EmailTransport {
  const captured = captureFromEnvironment(config, logger, env)
  if (captured) return captured

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
