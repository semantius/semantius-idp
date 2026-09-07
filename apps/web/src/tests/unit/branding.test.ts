/**
 * The branding file server's refusals.
 *
 * This is the only place in the deployment where a path from a URL becomes a
 * path on disk, so the tests are written as attacks rather than as usage. The
 * happy path is one case; the rest are the ways in.
 */

import { describe, expect, it } from "vitest"

import {
  BRANDING_CSP,
  brandingContentType,
  brandingResponseHeaders,
  brandingRoot,
  forgetBrandingRoot,
  safeBrandingPath,
} from "@/server/branding"

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

/**
 * What every branding response carries.
 *
 * `image/svg+xml` is a document: opened top-level, an SVG runs its own
 * `<script>` on this origin, and the site-wide policy is attached only to
 * `text/html`. So the file server writes its own, and it is the strictest one
 * there is — nothing may load and the document is sandboxed — on the served
 * file and on the refusal alike.
 */
describe("what every response carries", () => {
  it("attaches a no-op CSP and nosniff to a served file", () => {
    const headers = brandingResponseHeaders("logo.svg")
    expect(headers["Content-Security-Policy"]).toBe(BRANDING_CSP)
    expect(BRANDING_CSP).toBe("default-src 'none'; sandbox")
    expect(headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(headers["Content-Type"]).toBe("image/svg+xml")
  })

  it("attaches the same CSP to a refusal", () => {
    const headers = brandingResponseHeaders(undefined)
    expect(headers["Content-Security-Policy"]).toBe(BRANDING_CSP)
    expect(headers["Cache-Control"]).toBe("no-store")
    expect(headers["Content-Type"]).toBeUndefined()
  })
})

/**
 * The branding folder is resolved once per process: the config is
 * mounted read-only and re-reading and re-validating three files for every
 * favicon request bought nothing but latency. A configuration that cannot be
 * loaded is *not* remembered — the answer is a 404 either way, and the next
 * request asks again.
 */
describe("where it looks", () => {
  it("consults the configuration once and remembers the answer", () => {
    forgetBrandingRoot()
    let loads = 0
    const load = () => {
      loads += 1
      return { dir: "/config" }
    }
    const first = brandingRoot(load)
    const second = brandingRoot(load)
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(loads).toBe(1)
    // Still remembered when nothing is passed: the memo is the module's, not
    // the loader's.
    expect(brandingRoot(() => ({ dir: "/somewhere-else" }))).toBe(first)
    forgetBrandingRoot()
  })

  it("does not remember a configuration it could not load", () => {
    forgetBrandingRoot()
    let loads = 0
    const broken = () => {
      loads += 1
      throw new Error("config.jsonc: unreadable")
    }
    expect(brandingRoot(broken)).toBeUndefined()
    expect(brandingRoot(broken)).toBeUndefined()
    expect(loads).toBe(2)
    forgetBrandingRoot()
  })
})
