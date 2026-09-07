/**
 * The eleven e-mail templates.
 *
 * Every template produces HTML **and** text, is branded from `site.*`, and
 * builds every link from `server.baseUrl` only — never from a request header
 *. Strings come from the catalog; nothing here is a literal
 * a translator cannot reach.
 *
 * Templates are not user-customisable in v1, so the layout is one shared
 * function and each template only supplies its own content.
 */

import type { IdpConfig } from "../config/derive"
import type { Catalog } from "../i18n"
import { createBasePaths, APP_ROUTES } from "../oidc/base-path"
import type { EmailMessage } from "./transport"

export interface TemplateContext {
  config: IdpConfig
  t: Catalog
}

interface Layout {
  heading: string
  /** Paragraphs, in order. */
  paragraphs: string[]
  action?: { label: string; url: string }
  /** Small print under the action. */
  footnotes?: string[]
}

/** Minimal, self-contained HTML: no external stylesheet, no remote images. */
function render(
  context: TemplateContext,
  layout: Layout
): { html: string; text: string } {
  const { config, t } = context
  const siteName = config.file.site.name

  const html = `<!doctype html>
<html lang="${escapeHtml(t.locale)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(layout.heading)}</title>
  </head>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <p style="margin:0 0 24px;font-size:14px;font-weight:600;color:#5b6470;">${escapeHtml(siteName)}</p>
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">${escapeHtml(layout.heading)}</h1>
        ${layout.paragraphs
          .map(
            (paragraph) =>
              `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(paragraph)}</p>`
          )
          .join("\n        ")}
        ${
          layout.action
            ? `<p style="margin:24px 0;">
          <a href="${escapeHtml(layout.action.url)}" style="display:inline-block;padding:12px 20px;background:#1a1d21;color:#ffffff;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;">${escapeHtml(layout.action.label)}</a>
        </p>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#5b6470;">${escapeHtml(t.email.footer.linkFallback)}<br /><span style="word-break:break-all;">${escapeHtml(layout.action.url)}</span></p>`
            : ""
        }
        ${(layout.footnotes ?? [])
          .map(
            (note) =>
              `<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#5b6470;">${escapeHtml(note)}</p>`
          )
          .join("\n        ")}
        <hr style="border:none;border-top:1px solid #e6e8eb;margin:24px 0;" />
        <p style="margin:0;font-size:12px;line-height:1.6;color:#8a929c;">${escapeHtml(t.email.footer.sentBy(siteName))} ${escapeHtml(t.email.footer.doNotReply)}</p>
      </td></tr>
    </table>
  </body>
</html>`

  const text = [
    siteName,
    "",
    layout.heading,
    "",
    ...layout.paragraphs,
    ...(layout.action
      ? ["", layout.action.label + ":", layout.action.url]
      : []),
    ...(layout.footnotes && layout.footnotes.length > 0
      ? ["", ...layout.footnotes]
      : []),
    "",
    "—",
    `${t.email.footer.sentBy(siteName)} ${t.email.footer.doNotReply}`,
  ].join("\n")

  return { html, text }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Every link in every template goes through here. */
function link(
  config: IdpConfig,
  route: string,
  params: Record<string, string> = {}
): string {
  const paths = createBasePaths(config.base)
  const url = new URL(paths.url(route))
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value)
  return url.toString()
}

type Built = Omit<EmailMessage, "to">

export const templates = {
  /** 1 — confirm a new address. */
  verifyEmail(context: TemplateContext, input: { url: string }): Built {
    const { t, config } = context
    const body = render(context, {
      heading: t.email.verify.heading,
      paragraphs: [t.email.verify.body(config.file.site.name)],
      action: { label: t.email.verify.action, url: input.url },
      footnotes: [t.email.verify.expiry, t.email.verify.ignore],
    })
    return {
      subject: t.email.verify.subject(config.file.site.name),
      template: "verify-email",
      ...body,
    }
  },

  /** 2 — password reset. */
  resetPassword(context: TemplateContext, input: { url: string }): Built {
    const { t, config } = context
    const body = render(context, {
      heading: t.email.resetPassword.heading,
      paragraphs: [t.email.resetPassword.body],
      action: { label: t.email.resetPassword.action, url: input.url },
      footnotes: [
        t.email.resetPassword.expiry(
          config.file.auth.passwordReset.tokenTtlMinutes
        ),
        t.email.resetPassword.ignore,
      ],
    })
    return {
      subject: t.email.resetPassword.subject(config.file.site.name),
      template: "reset-password",
      ...body,
    }
  },

  /** 3 — an admin created the account. */
  setPassword(context: TemplateContext, input: { url: string }): Built {
    const { t, config } = context
    const body = render(context, {
      heading: t.email.setPassword.heading,
      paragraphs: [t.email.setPassword.body(config.file.site.name)],
      action: { label: t.email.setPassword.action, url: input.url },
      footnotes: [
        t.email.setPassword.expiry(
          config.file.auth.passwordReset.tokenTtlMinutes
        ),
      ],
    })
    return {
      subject: t.email.setPassword.subject(config.file.site.name),
      template: "set-password",
      ...body,
    }
  },

  /** 4 — to every admin, when someone signs up. */
  pendingSignUp(
    context: TemplateContext,
    input: { applicantEmail: string }
  ): Built {
    const { t, config } = context
    const body = render(context, {
      heading: t.email.pendingSignUp.heading,
      paragraphs: [t.email.pendingSignUp.body(input.applicantEmail)],
      action: {
        label: t.email.pendingSignUp.action,
        url: link(config, `${APP_ROUTES.admin}/users`, { status: "pending" }),
      },
    })
    return {
      subject: t.email.pendingSignUp.subject(config.file.site.name),
      template: "pending-signup",
      ...body,
    }
  },

  /** 5 — approved. */
  accountApproved(context: TemplateContext): Built {
    const { t, config } = context
    const body = render(context, {
      heading: t.email.approved.heading,
      paragraphs: [t.email.approved.body(config.file.site.name)],
      action: {
        label: t.email.approved.action,
        url: link(config, APP_ROUTES.login),
      },
    })
    return {
      subject: t.email.approved.subject(config.file.site.name),
      template: "account-approved",
      ...body,
    }
  },

  /** 6 — rejected (optional). */
  accountRejected(context: TemplateContext): Built {
    const { t, config } = context
    const support = config.file.site.supportEmail
    const body = render(context, {
      heading: t.email.rejected.heading,
      paragraphs: [t.email.rejected.body],
      footnotes: support ? [t.email.rejected.contact(support)] : [],
    })
    return {
      subject: t.email.rejected.subject(config.file.site.name),
      template: "account-rejected",
      ...body,
    }
  },

  /** 7 — the password changed. */
  passwordChanged(context: TemplateContext): Built {
    const { t, config } = context
    const body = render(context, {
      heading: t.email.passwordChanged.heading,
      paragraphs: [
        t.email.passwordChanged.body,
        t.email.passwordChanged.warning,
      ],
      action: {
        label: t.email.passwordChanged.action,
        url: link(config, APP_ROUTES.forgotPassword),
      },
    })
    return {
      subject: t.email.passwordChanged.subject(config.file.site.name),
      template: "password-changed",
      ...body,
    }
  },

  /** 8 — second factor turned on or off. */
  twoFactorChanged(
    context: TemplateContext,
    input: { enabled: boolean }
  ): Built {
    const { t, config } = context
    const body = render(context, {
      heading: input.enabled
        ? t.email.twoFactorChanged.headingEnabled
        : t.email.twoFactorChanged.headingDisabled,
      paragraphs: [
        t.email.twoFactorChanged.body,
        t.email.twoFactorChanged.warning,
      ],
    })
    return {
      subject: t.email.twoFactorChanged.subject(
        config.file.site.name,
        input.enabled
      ),
      template: "two-factor-changed",
      ...body,
    }
  },

  /**
   * 9 — an administrator reset the second factor.
   *
   * Sent to the user rather than to the administrator, because the user is the
   * only person who can tell whether the reset was legitimate — and if it was
   * not, this message is the first sign that someone talked their way past the
   * help desk.
   */
  twoFactorReset(context: TemplateContext): Built {
    const { t, config } = context
    const body = render(context, {
      heading: t.email.twoFactorReset.heading,
      paragraphs: [t.email.twoFactorReset.body, t.email.twoFactorReset.warning],
      action: {
        label: t.email.twoFactorReset.action,
        url: link(config, `${APP_ROUTES.account}/security`),
      },
    })
    return {
      subject: t.email.twoFactorReset.subject(config.file.site.name),
      template: "two-factor-reset",
      ...body,
    }
  },

  /**
   * 11 — someone tried to register with an address that already has an
   * account.
   *
   * Sent to the **existing** owner, never to whoever typed the address: with
   * e-mail on, `/signup` answers a taken address exactly as it answers a new
   * one, and this message is the only thing that distinguishes the two — in
   * the one inbox that was going to hear about it either way. No link into
   * the account, and the reset link is the ordinary forgot-password page: if
   * it was the owner who forgot they had an account, that is the way back in,
   * and if it was not, the message is the tip-off that someone knows the
   * address.
   */
  signUpExistingAccount(context: TemplateContext): Built {
    const { t, config } = context
    const body = render(context, {
      heading: t.email.signUpExisting.heading,
      paragraphs: [
        t.email.signUpExisting.body(config.file.site.name),
        t.email.signUpExisting.hint,
      ],
      action: {
        label: t.email.signUpExisting.action,
        url: link(config, APP_ROUTES.forgotPassword),
      },
      footnotes: [t.email.signUpExisting.ignore],
    })
    return {
      subject: t.email.signUpExisting.subject(config.file.site.name),
      template: "signup-existing-account",
      ...body,
    }
  },

  /** 10 — an API key was created. */
  apiKeyCreated(context: TemplateContext, input: { keyName: string }): Built {
    const { t, config } = context
    const body = render(context, {
      heading: t.email.apiKeyCreated.heading,
      paragraphs: [
        t.email.apiKeyCreated.body(input.keyName),
        t.email.apiKeyCreated.warning,
      ],
      action: {
        label: t.email.apiKeyCreated.action,
        url: link(config, `${APP_ROUTES.account}/api-keys`),
      },
    })
    return {
      subject: t.email.apiKeyCreated.subject(config.file.site.name),
      template: "api-key-created",
      ...body,
    }
  },
} as const

export type TemplateName = keyof typeof templates
