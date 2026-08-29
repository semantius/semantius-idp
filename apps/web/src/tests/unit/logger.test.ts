import { describe, expect, it } from "vitest"

import {
  anonymizeIp,
  createLogger,
  redactFields,
  safeUrlForLog,
} from "@/server/logger"

function capture(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = []
  const logger = createLogger({
    now: () => new Date("2026-08-23T12:00:00.000Z"),
    write: (line) => lines.push(line),
    ...options,
  })
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line)) }
}

describe("SEC-5 redaction", () => {
  it("never emits a password, token, secret or link", () => {
    const { logger, lines } = capture()
    logger.info("sign-in attempt", {
      email: "user@example.com",
      password: "hunter2",
      accessToken: "eyJhbGciOi...",
      refresh_token: "rt_live_123",
      clientSecret: "cs_live_456",
      url: "https://idp.example.com/reset-password?token=abc",
      code: "authcode",
      cookie: "idp.session_token=zzz",
      authorization: "Bearer eyJ...",
    })

    const output = lines.join("\n")
    for (const secret of [
      "hunter2",
      "eyJhbGciOi",
      "rt_live_123",
      "cs_live_456",
      "reset-password?token=abc",
      "authcode",
      "idp.session_token=zzz",
      "Bearer eyJ",
    ]) {
      expect(output).not.toContain(secret)
    }
    // Non-secret context survives, or the log would be useless.
    expect(output).toContain("user@example.com")
    expect(output).toContain("sign-in attempt")
  })

  it("redacts case- and separator-insensitively", () => {
    const redacted = redactFields({
      Password: "a",
      ACCESS_TOKEN: "b",
      "set-cookie": "c",
      apiKey: "d",
      api_key: "e",
    })
    expect(Object.values(redacted)).toEqual(Array(5).fill("[redacted]"))
  })

  it("redacts inside nested objects and arrays", () => {
    const redacted = redactFields({
      request: { headers: { authorization: "Bearer x" } },
      keys: [{ secret: "s1" }, { secret: "s2" }],
    }) as {
      request: { headers: { authorization: string } }
      keys: { secret: string }[]
    }
    expect(redacted.request.headers.authorization).toBe("[redacted]")
    expect(redacted.keys.map((key) => key.secret)).toEqual([
      "[redacted]",
      "[redacted]",
    ])
  })

  it("keeps an Error readable without walking into it forever", () => {
    const redacted = redactFields({ err: new Error("boom") }) as {
      err: { name: string; message: string }
    }
    expect(redacted.err.name).toBe("Error")
    expect(redacted.err.message).toBe("boom")
  })

  it("stops at a sane depth rather than recursing on a cycle", () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let i = 0; i < 12; i++) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    expect(() => redactFields(deep)).not.toThrow()
    expect(JSON.stringify(redactFields(deep))).toContain("[deep]")
  })
})

describe("safeUrlForLog (SEC-5)", () => {
  it("drops the query string of protocol endpoints", () => {
    expect(
      safeUrlForLog(
        "https://idp.example.com/oauth2/authorize?client_id=a&state=b"
      )
    ).toBe("/oauth2/authorize?[redacted]")
    expect(safeUrlForLog("/api/auth/callback/google?code=secret&state=x")).toBe(
      "/api/auth/callback/google?[redacted]"
    )
  })

  it("keeps ordinary query strings, which are useful and not sensitive", () => {
    expect(safeUrlForLog("/admin/users?page=2&status=pending")).toBe(
      "/admin/users?page=2&status=pending"
    )
  })

  it("keeps a protocol path with no query as-is", () => {
    expect(safeUrlForLog("/oauth2/token")).toBe("/oauth2/token")
  })

  it("still redacts under a sub-path mount (OPS-10)", () => {
    // A prefix check passed at the host root and silently logged every
    // authorization code the moment `server.baseUrl` grew a path.
    expect(safeUrlForLog("/idp/oauth2/authorize?client_id=a&code=b")).toBe(
      "/idp/oauth2/authorize?[redacted]"
    )
    expect(safeUrlForLog("/idp/api/auth/callback/google?code=secret")).toBe(
      "/idp/api/auth/callback/google?[redacted]"
    )
  })

  it("redacts our own pages that carry a credential in the query", () => {
    // Each of these is a bearer of something: a single-use token, or the
    // signed authorization request of FR-OIDC-9.
    for (const path of [
      "/reset-password?token=abc",
      "/verify-email?token=abc",
      "/change-password?forced=1&oauth_query=sig%3Dx",
      "/two-factor?oauth_query=sig%3Dx",
      "/consent?sig=x&client_id=y",
      "/login?oauth_query=sig%3Dx",
      "/idp/reset-password?token=abc",
    ]) {
      expect(safeUrlForLog(path), path).toMatch(/\?\[redacted\]$/)
    }
  })
})

describe("anonymizeIp (SEC-5)", () => {
  it("drops the last IPv4 octet", () => {
    expect(anonymizeIp("203.0.113.42")).toBe("203.0.113.0")
  })

  it("truncates IPv6 to its /64", () => {
    expect(anonymizeIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe(
      "2001:db8:85a3:8d3::"
    )
  })

  it("returns undefined for nothing useful", () => {
    expect(anonymizeIp(undefined)).toBeUndefined()
    expect(anonymizeIp("")).toBeUndefined()
    expect(anonymizeIp("not-an-ip")).toBeUndefined()
  })
})

describe("logger behavior", () => {
  it("emits one JSON object per line with time, level and msg", () => {
    const { logger, records } = capture()
    logger.warn("careful", { requestId: "req-1" })
    expect(records()).toEqual([
      {
        time: "2026-08-23T12:00:00.000Z",
        level: "warn",
        msg: "careful",
        requestId: "req-1",
      },
    ])
  })

  it("filters below the configured level", () => {
    const { logger, lines } = capture({ level: "warn" })
    logger.debug("noise")
    logger.info("noise")
    logger.warn("kept")
    logger.error("kept")
    expect(lines).toHaveLength(2)
  })

  it("stamps child fields onto every record", () => {
    const { logger, records } = capture()
    logger.child({ requestId: "req-9" }).info("handled")
    expect(records()[0]).toMatchObject({ requestId: "req-9", msg: "handled" })
  })

  it("redacts fields inherited from a child logger too", () => {
    const { logger, lines } = capture()
    logger.child({ secret: "inherited" }).info("x")
    expect(lines.join("")).not.toContain("inherited")
  })

  it("writes a readable line in pretty format", () => {
    const { logger, lines } = capture({ format: "pretty" })
    logger.info("hello", { a: 1 })
    expect(lines[0]).toBe('2026-08-23T12:00:00.000Z INFO  hello {"a":1}')
  })
})
