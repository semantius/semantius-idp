/**
 * The branding file server's refusals (CFG-1).
 *
 * This is the only place in the deployment where a path from a URL becomes a
 * path on disk, so the tests are written as attacks rather than as usage. The
 * happy path is one case; the rest are the ways in.
 */

import { describe, expect, it } from "vitest"

import { brandingContentType, safeBrandingPath } from "@/server/branding"

describe("what it will serve", () => {
  it("accepts a plain file in the branding folder", () => {
    expect(safeBrandingPath("logo.svg")).toBe("logo.svg")
    expect(safeBrandingPath("dark/logo.png")).toBe("dark/logo.png")
  })

  it("decodes before deciding", () => {
    expect(safeBrandingPath("my%20logo.png")).toBe("my logo.png")
  })

  it("names the content type rather than guessing it", () => {
    expect(brandingContentType("logo.svg")).toBe("image/svg+xml")
    expect(brandingContentType("LOGO.SVG")).toBe("image/svg+xml")
    expect(brandingContentType("icon.ico")).toBe("image/x-icon")
    expect(brandingContentType("f.woff2")).toBe("font/woff2")
  })
})

describe("what it refuses", () => {
  const attacks: [string, string][] = [
    ["climbing out", "../config.json"],
    ["climbing out from deeper", "dark/../../config.json"],
    ["climbing out, encoded", "%2e%2e%2fconfig.json"],
    ["an absolute path", "/etc/passwd"],
    ["a Windows absolute path", "C:/Windows/win.ini"],
    ["a backslash, which resolve() treats as a separator on Windows", "..\\config.json"],
    ["a bare backslash anywhere", "dark\\logo.svg"],
    ["a null byte", "logo.svg\0.txt"],
    ["a URL", "https://evil.example.com/logo.svg"],
    ["a protocol-relative URL", "//evil.example.com/logo.svg"],
    ["nothing at all", ""],
    ["a malformed escape", "%E0%A4%A"],
  ]

  it.each(attacks)("refuses %s", (_label, path) => {
    expect(safeBrandingPath(path)).toBeUndefined()
  })

  it("refuses an extension it has no content type for", () => {
    // Not because these would be dangerous to read — the folder is the
    // operator's — but because serving a file whose type it had to guess is
    // how a branding folder becomes an HTML hosting service.
    expect(safeBrandingPath("config.json")).toBeUndefined()
    expect(safeBrandingPath("notes.html")).toBeUndefined()
    expect(safeBrandingPath("key.pem")).toBeUndefined()
    expect(safeBrandingPath("logo")).toBeUndefined()
  })

  it("refuses a double extension that ends in something unknown", () => {
    expect(safeBrandingPath("logo.svg.html")).toBeUndefined()
  })
})
