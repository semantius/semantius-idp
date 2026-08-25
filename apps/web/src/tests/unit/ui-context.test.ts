/**
 * `buildUiContext` — the capability flags and branding the public pages get.
 *
 * The branding URLs are the part with a sharp edge: they are the only values
 * in the context that the browser dereferences, so a mount path that is
 * missing from them is a request to somebody else's application (spike S3).
 */

import { describe, expect, it } from "vitest"

import { loadConfig } from "@/server/config/loader"
import { buildUiContext } from "@/server/ui-context"
import { baseConfig, makeConfigFolder } from "../fixtures/config-files"

function contextFor(site: Record<string, unknown>, baseUrl?: string) {
  const config: Record<string, unknown> = {
    ...baseConfig(),
    site: { name: "Test IdP", ...site },
  }
  if (baseUrl) config.server = { baseUrl }
  const folder = makeConfigFolder({ config })
  const loaded = loadConfig({
    dir: "/config",
    readFile: folder.readFile,
    env: {},
  })
  return buildUiContext(loaded.config, "en-US")
}

describe("buildUiContext branding", () => {
  it("falls back to the icon shipped in the image", () => {
    expect(contextFor({}).favicon).toBe("/favicon.ico")
  })

  it("puts the fallback icon on the mount path", () => {
    // A bare `/favicon.ico` is what a browser probes on its own, and under a
    // sub-path that hits the origin root — the 404 spike S3 found.
    expect(contextFor({}, "http://localhost:3000/idp").favicon).toBe(
      "/idp/favicon.ico"
    )
  })

  it("serves configured branding files from /branding", () => {
    const ui = contextFor(
      { logo: "logo.svg", favicon: "favicon.ico" },
      "http://localhost:3000/idp"
    )
    expect(ui.logo).toBe("/idp/branding/logo.svg")
    expect(ui.favicon).toBe("/idp/branding/favicon.ico")
  })

  it("accepts the config-folder-relative spelling as the same file", () => {
    // The schema says "path under `branding/`" and the shipped example says
    // `branding/logo.svg`. Both name `${configDir}/branding/logo.svg`, so both
    // have to produce the URL that serves it — otherwise every operator who
    // copied the example gets `/branding/branding/logo.svg` and a 404.
    const ui = contextFor(
      { logo: "branding/logo.svg", favicon: "/branding/favicon.ico" },
      "http://localhost:3000/idp"
    )
    expect(ui.logo).toBe("/idp/branding/logo.svg")
    expect(ui.favicon).toBe("/idp/branding/favicon.ico")
  })

  it("leaves an absolute logo URL alone", () => {
    const ui = contextFor(
      { logo: "https://cdn.example.com/logo.svg" },
      "http://localhost:3000/idp"
    )
    expect(ui.logo).toBe("https://cdn.example.com/logo.svg")
  })

  it("carries the mount path for in-app links", () => {
    expect(contextFor({}, "http://localhost:3000/idp").basePath).toBe("/idp")
    expect(contextFor({}).basePath).toBe("")
  })
})
