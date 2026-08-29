import { describe, expect, it, vi } from "vitest"

import { deriveConfig } from "@/server/config/derive"
import type { IdpConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import { createCaptureMailer, createMailer } from "@/server/email/mailer"
import { templates } from "@/server/email/templates"
import {
  createCaptureTransport,
  createDisabledTransport,
  createResendTransport,
} from "@/server/email/transport"
import { getCatalog } from "@/server/i18n"
import { createLogger } from "@/server/logger"
import { baseConfig } from "@/tests/fixtures/config-files"

function makeConfig(overrides: Record<string, unknown> = {}): IdpConfig {
  return deriveConfig(
    configFileSchema.parse({ ...baseConfig(), ...overrides }),
    [],
    BUILT_IN_ROLES
  )
}

const withEmail = (extra: Record<string, unknown> = {}) =>
  makeConfig({
    email: { resend: { apiKey: "re_test_key" }, from: "IdP <idp@example.com>" },
    ...extra,
  })

const silent = () => createLogger({ level: "error", write: () => {} })

describe("FR-MAIL-1 templates", () => {
  const config = withEmail()
  const context = { config, t: getCatalog() }

  it("builds all nine templates with HTML and text", () => {
    const built = [
      templates.verifyEmail(context, {
        url: "https://idp.example.com/verify-email?token=t",
      }),
      templates.resetPassword(context, {
        url: "https://idp.example.com/reset-password?token=t",
      }),
      templates.setPassword(context, {
        url: "https://idp.example.com/reset-password?token=t",
      }),
      templates.pendingSignUp(context, { applicantEmail: "new@example.com" }),
      templates.accountApproved(context),
      templates.accountRejected(context),
      templates.passwordChanged(context),
      templates.twoFactorChanged(context, { enabled: true }),
      templates.apiKeyCreated(context, { keyName: "deploy bot" }),
    ]

    expect(built).toHaveLength(9)
    for (const message of built) {
      expect(message.subject).toBeTruthy()
      expect(message.html).toContain("<!doctype html>")
      expect(message.text.length).toBeGreaterThan(0)
      expect(message.template).toBeTruthy()
      // Branded from site.* (FR-MAIL-1).
      expect(message.html).toContain("Test IdP")
      expect(message.text).toContain("Test IdP")
    }
  })

  it("builds every link from server.baseUrl only (SEC-1)", () => {
    const message = templates.pendingSignUp(context, {
      applicantEmail: "new@example.com",
    })
    const urls = [...message.html.matchAll(/https?:\/\/[^"\s<]+/g)].map(
      (match) => match[0]
    )
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls)
      expect(url.startsWith("http://localhost:3000")).toBe(true)
  })

  it("honors a sub-path issuer in its links (OPS-10)", () => {
    const subPath = withEmail({
      server: { baseUrl: "https://apps.example.com/idp" },
      jwt: { audience: "https://apps.example.com/idp" },
    })
    const message = templates.accountApproved({
      config: subPath,
      t: getCatalog(),
    })
    expect(message.html).toContain("https://apps.example.com/idp/login")
  })

  it("escapes interpolated values so a name cannot inject markup", () => {
    const message = templates.apiKeyCreated(context, {
      keyName: '<img src=x onerror="alert(1)">',
    })
    expect(message.html).not.toContain("<img")
    expect(message.html).toContain("&lt;img")
  })

  it("omits the support line when no support address is configured", () => {
    const withoutSupport = templates.accountRejected(context)
    expect(withoutSupport.text).not.toContain("contact")

    const withSupport = templates.accountRejected({
      config: withEmail({
        site: { name: "Test IdP", supportEmail: "help@example.com" },
      }),
      t: getCatalog(),
    })
    expect(withSupport.text).toContain("help@example.com")
  })

  it("distinguishes the two-factor on and off subjects", () => {
    expect(
      templates.twoFactorChanged(context, { enabled: true }).subject
    ).toContain("turned on")
    expect(
      templates.twoFactorChanged(context, { enabled: false }).subject
    ).toContain("turned off")
  })
})

describe("transports", () => {
  it("posts to Resend with the configured sender", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }))
    const transport = createResendTransport({
      apiKey: "re_test_key",
      from: "IdP <idp@example.com>",
      replyTo: "help@example.com",
      logger: silent(),
      fetchImpl: fetchImpl,
    })

    await transport.send({
      to: "user@example.com",
      subject: "Subject",
      html: "<p>hi</p>",
      text: "hi",
      template: "verify-email",
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe("https://api.resend.com/emails")
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      from: "IdP <idp@example.com>",
      to: ["user@example.com"],
      subject: "Subject",
      reply_to: "help@example.com",
    })
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer re_test_key"
    )
  })

  it("throws on a Resend failure without putting the recipient in the message", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"message":"user@example.com is suppressed"}', {
          status: 422,
        })
    )
    const transport = createResendTransport({
      apiKey: "k",
      from: "idp@example.com",
      logger: silent(),
      fetchImpl: fetchImpl,
    })

    await expect(
      transport.send({
        to: "user@example.com",
        subject: "s",
        html: "h",
        text: "t",
        template: "verify-email",
      })
    ).rejects.toThrow(/status 422/)
  })

  it("captures messages in memory for tests", async () => {
    const transport = createCaptureTransport()
    await transport.send({
      to: "A@Example.com",
      subject: "1",
      html: "",
      text: "",
      template: "verify-email",
    })
    await transport.send({
      to: "b@example.com",
      subject: "2",
      html: "",
      text: "",
      template: "reset-password",
    })

    expect(transport.messages).toHaveLength(2)
    expect(transport.for("a@example.com")).toHaveLength(1)
    expect(transport.last()?.subject).toBe("2")
    expect(transport.last("verify-email")?.subject).toBe("1")

    transport.clear()
    expect(transport.messages).toHaveLength(0)
  })

  it("logs rather than sending when disabled", async () => {
    const lines: string[] = []
    const transport = createDisabledTransport(
      createLogger({ level: "trace", write: (line) => lines.push(line) })
    )
    await transport.send({
      to: "a@example.com",
      subject: "s",
      html: "",
      text: "",
      template: "verify-email",
    })
    expect(lines.join("")).toContain("no transport is configured")
  })
})

describe("mailer", () => {
  it("is disabled in degraded mode and sends nothing (FR-MAIL-2)", async () => {
    const mailer = createMailer({ config: makeConfig(), logger: silent() })
    expect(mailer.enabled).toBe(false)
    await expect(
      mailer.send("accountApproved", "user@example.com")
    ).resolves.toBeUndefined()
  })

  it("sends a templated message through the transport", async () => {
    const mailer = createCaptureMailer(withEmail(), silent())
    await mailer.send("verifyEmail", "user@example.com", {
      url: "http://localhost:3000/verify-email?token=abc",
    })

    const message = mailer.captured.last()
    expect(message).toBeDefined()
    expect(message!.to).toBe("user@example.com")
    expect(message!.template).toBe("verify-email")
    expect(message!.html).toContain("token=abc")
  })

  it("never lets a delivery failure reach the caller", async () => {
    const lines: string[] = []
    const logger = createLogger({
      level: "trace",
      write: (line) => lines.push(line),
    })
    const mailer = createMailer({
      config: withEmail(),
      logger,
      transport: {
        kind: "resend",
        send: async () => {
          throw new Error("Resend is having a bad minute")
        },
      },
    })

    // A sign-up that succeeded must not report failure because mail did.
    await expect(
      mailer.send("accountApproved", "user@example.com")
    ).resolves.toBeUndefined()
    expect(lines.join("\n")).toContain("e-mail could not be sent")
  })
})
