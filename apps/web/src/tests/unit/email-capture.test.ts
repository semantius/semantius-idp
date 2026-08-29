/**
 * The capture transport's file half (D30).
 *
 * This exists so the e2e run can read a verification or reset link out of the
 * **built image**, where there is no in-process handle to reach for. D30 chose
 * files over an HTTP endpoint because an endpoint that returns captured mail is
 * an endpoint that returns password-reset links, and it would exist in the
 * shipped image.
 *
 * Three properties are worth pinning: the switch is environment-only, it is
 * ignored in degraded mode, and a failure to write never breaks a send.
 */

import { describe, expect, it, vi } from "vitest"

import { createMailer } from "@/server/email/mailer"
import { createCaptureTransport } from "@/server/email/transport"
import { deriveConfig } from "@/server/config/derive"
import { configFileSchema } from "@/server/config/schema/config-schema"
import { BUILT_IN_ROLES } from "@/server/config/schema/roles-schema"
import { createLogger } from "@/server/logger"

const silent = createLogger({ level: "error", write: () => {} })

function configWith(email: Record<string, unknown>) {
  return deriveConfig(
    configFileSchema.parse({
      server: { baseUrl: "http://localhost:3000" },
      secret: "capture-test-secret-0123456789abcdef",
      database: { url: "postgres://u:p@localhost:5432/idp" },
      site: { name: "Capture" },
      jwt: { audience: "http://localhost:3000" },
      email,
    }),
    [],
    BUILT_IN_ROLES
  )
}

const WORKING = { resend: { apiKey: "re_test" }, from: "IdP <idp@x.test>" }

describe("the file half of the capture transport", () => {
  it("writes one JSON file per message, named for arrival and recipient", async () => {
    const written: { path: string; contents: string }[] = []
    const transport = createCaptureTransport({
      directory: "/tmp/idp-mail",
      writeFile: async (path, contents) => {
        written.push({ path, contents })
      },
      mkdir: async () => undefined,
    })

    await transport.send({
      to: "Someone@Example.com",
      subject: "Verify",
      html: "<p>x</p>",
      text: "x",
      template: "verifyEmail",
    })

    expect(written).toHaveLength(1)
    expect(written[0]!.path).toMatch(
      /^\/tmp\/idp-mail\/\d{4}-verifyEmail-Someone@Example\.com\.json$/
    )
    const parsed = JSON.parse(written[0]!.contents) as Record<string, unknown>
    expect(parsed).toMatchObject({ to: "Someone@Example.com", text: "x" })
    expect(parsed.capturedAt).toEqual(expect.any(String))

    // The in-memory record is still the contract every existing caller uses.
    expect(transport.last("verifyEmail")?.subject).toBe("Verify")
  })

  it("keeps a path-shaped recipient inside the directory", async () => {
    const written: string[] = []
    const transport = createCaptureTransport({
      directory: "/tmp/idp-mail",
      writeFile: async (path) => {
        written.push(path)
      },
      mkdir: async () => undefined,
    })

    await transport.send({
      to: "../../etc/passwd",
      subject: "s",
      html: "h",
      text: "t",
      template: "passwordReset",
    })

    // The recipient reaches this from a sign-up form. Sanitised rather than
    // encoded: the separators are gone, so the file cannot land outside the
    // directory whatever else survives.
    expect(written[0]).toMatch(/^\/tmp\/idp-mail\/\d{4}-passwordReset-/)
    expect(written[0]!.slice("/tmp/idp-mail/".length)).not.toContain("/")
    // And no literal `..` in the name either — harmless here, but plenty of
    // tooling downstream reads it as a traversal.
    expect(written[0]).not.toContain("..")
  })

  it("does not fail a send when the directory cannot be written", async () => {
    const transport = createCaptureTransport({
      directory: "/nowhere",
      logger: silent,
      mkdir: async () => {
        throw new Error("read-only file system")
      },
      writeFile: async () => undefined,
    })

    await expect(
      transport.send({
        to: "a@b.test",
        subject: "s",
        html: "h",
        text: "t",
        template: "welcome",
      })
    ).resolves.toBeUndefined()

    // A capture directory that cannot be written is a broken harness, not a
    // broken deployment — and the message is still recorded in memory.
    expect(transport.messages).toHaveLength(1)
  })
})

describe("the D30 environment switch", () => {
  it("replaces the real transport when IDP_EMAIL_TRANSPORT=capture", () => {
    const mailer = createMailer({
      config: configWith(WORKING),
      logger: silent,
      env: { IDP_EMAIL_TRANSPORT: "capture" },
    })

    expect(mailer.transport.kind).toBe("capture")
    expect(mailer.enabled).toBe(true)
  })

  it("sends for real when the variable is absent or anything else", () => {
    for (const env of [{}, { IDP_EMAIL_TRANSPORT: "resend" }, { IDP_EMAIL_TRANSPORT: "" }]) {
      expect(
        createMailer({ config: configWith(WORKING), logger: silent, env })
          .transport.kind
      ).toBe("resend")
    }
  })

  it("is ignored in degraded mode", () => {
    // FR-MAIL-2: with no key nothing is sent, and that is the requirement.
    // Capturing here would make the one behavior where "nothing is sent" is
    // correct indistinguishable from one where it is a bug.
    const mailer = createMailer({
      config: configWith({ resend: { apiKey: "" }, from: "IdP <idp@x.test>" }),
      logger: silent,
      env: { IDP_EMAIL_TRANSPORT: "capture" },
    })

    expect(mailer.transport.kind).toBe("disabled")
    expect(mailer.enabled).toBe(false)
  })

  it("says loudly that nothing will be sent", () => {
    const warn = vi.fn()
    createMailer({
      config: configWith(WORKING),
      logger: { ...silent, warn },
      env: { IDP_EMAIL_TRANSPORT: "capture" },
    })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("capture transport"),
      expect.objectContaining({ directory: "/tmp/idp-mail" })
    )
  })
})
