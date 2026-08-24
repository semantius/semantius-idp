/**
 * `src/lib/base-path.ts` — the mount path as the browser bundle sees it.
 *
 * The interesting cases are all "did the sub-path deployment survive": every
 * one of these was a live 404 during spike S3 before the wiring existed.
 */

import { afterEach, describe, expect, it } from "vitest"

import {
  BASE_PATH_ATTRIBUTE,
  assetUrl,
  resetRuntimeBasePath,
  runtimeBasePath,
  setRuntimeBasePath,
  withBasePath,
} from "@/lib/base-path"

afterEach(() => {
  resetRuntimeBasePath()
})

describe("runtimeBasePath", () => {
  it("is the host root until the server entry says otherwise", () => {
    expect(runtimeBasePath()).toBe("")
  })

  it("does not cache the host-root default on the server", () => {
    // Reading before `setRuntimeBasePath` must not pin `""` for the process:
    // the server entry resolves configuration lazily, and a cached empty
    // answer would silently un-mount every later request.
    expect(runtimeBasePath()).toBe("")
    setRuntimeBasePath("/idp")
    expect(runtimeBasePath()).toBe("/idp")
  })

  it("names the attribute the document carries", () => {
    expect(BASE_PATH_ATTRIBUTE).toBe("data-base-path")
  })
})

describe("withBasePath", () => {
  it("passes paths through unchanged at the host root", () => {
    setRuntimeBasePath("")
    expect(withBasePath("/_serverFn/abc")).toBe("/_serverFn/abc")
  })

  it("moves an absolute path onto the mount", () => {
    setRuntimeBasePath("/idp")
    expect(withBasePath("/_serverFn/abc")).toBe("/idp/_serverFn/abc")
  })

  it("does not prefix twice", () => {
    setRuntimeBasePath("/idp")
    expect(withBasePath("/idp/_serverFn/abc")).toBe("/idp/_serverFn/abc")
    expect(withBasePath("/idp")).toBe("/idp")
  })

  it("leaves a path that merely starts with the same letters alone", () => {
    setRuntimeBasePath("/idp")
    expect(withBasePath("/idpx/thing")).toBe("/idp/idpx/thing")
  })

  it("leaves relative and absolute URLs alone", () => {
    setRuntimeBasePath("/idp")
    expect(withBasePath("relative")).toBe("relative")
    expect(withBasePath("https://example.com/x")).toBe("https://example.com/x")
  })
})

describe("assetUrl", () => {
  it("pins a document-relative build asset to the mount path", () => {
    setRuntimeBasePath("/idp")
    // Without this, `/idp/account/security` would ask for
    // `/idp/account/assets/globals-abc.css`.
    expect(assetUrl("./assets/globals-abc.css")).toBe(
      "/idp/assets/globals-abc.css"
    )
  })

  it("rewrites to a root-absolute path at the host root", () => {
    setRuntimeBasePath("")
    expect(assetUrl("./assets/globals-abc.css")).toBe("/assets/globals-abc.css")
  })

  it("leaves the browser's already-absolute value alone", () => {
    setRuntimeBasePath("/idp")
    expect(assetUrl("http://host/idp/assets/globals-abc.css")).toBe(
      "http://host/idp/assets/globals-abc.css"
    )
  })
})
