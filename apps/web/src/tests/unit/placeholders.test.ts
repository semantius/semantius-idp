import { describe, expect, it } from "vitest"

import { substitutePlaceholders } from "@/server/config/placeholders"

const env = {
  IDP_SECRET: "super-secret-value",
  IDP_PORT: "8080",
  IDP_FLAG: "true",
  IDP_LIST: '["a","b"]',
  IDP_EMPTY: "",
}

function subst(input: unknown, files: Record<string, string> = {}) {
  return substitutePlaceholders("config.json", input, {
    env,
    readFile: (path) => {
      const content = files[path]
      if (content === undefined) throw new Error("ENOENT")
      return content
    },
    isAbsolutePath: (path) => path.startsWith("/"),
  })
}

describe("CFG-2 placeholder grammar", () => {
  it("resolves ${env:NAME}", () => {
    const result = subst({ secret: "${env:IDP_SECRET}" })
    expect(result.issues).toEqual([])
    expect(result.value).toEqual({ secret: "super-secret-value" })
    expect([...result.placeholderPointers]).toEqual(["/secret"])
  })

  it("uses the default of ${env:NAME:-default} when unset", () => {
    const result = subst({ a: "${env:MISSING:-fallback}" })
    expect(result.issues).toEqual([])
    expect(result.value).toEqual({ a: "fallback" })
  })

  it("uses the default when the variable is set but empty (shell :- semantics)", () => {
    const result = subst({ a: "${env:IDP_EMPTY:-fallback}" })
    expect(result.value).toEqual({ a: "fallback" })
  })

  it("allows an empty default, which is how bootstrap admin values are made optional", () => {
    const result = subst({ email: "${env:IDP_ADMIN_EMAIL:-}" })
    expect(result.issues).toEqual([])
    expect(result.value).toEqual({ email: "" })
  })

  it("errors on an unresolved variable without a default, naming file, pointer and variable but never a value", () => {
    const result = subst({ nested: { key: "${env:NOT_SET}" } })
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({
      file: "config.json",
      pointer: "/nested/key",
    })
    expect(result.issues[0]!.message).toContain("NOT_SET")
    expect(result.issues[0]!.message).not.toContain("super-secret-value")
  })

  it("rejects an un-namespaced ${VAR} with a hint", () => {
    const result = subst({ a: "${IDP_SECRET}" })
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]!.message).toContain("Un-namespaced")
    expect(result.issues[0]!.hint).toContain("${env:IDP_SECRET}")
    // The value is left untouched so no half-substituted string leaks onward.
    expect(result.value).toEqual({ a: "${IDP_SECRET}" })
  })

  it("rejects a malformed placeholder", () => {
    expect(subst({ a: "${nope:x}" }).issues[0]!.message).toContain("Malformed")
    expect(subst({ a: "${env:lower_case}" }).issues[0]!.message).toContain(
      "Invalid environment variable name"
    )
    expect(subst({ a: "${env:IDP_SECRET" }).issues[0]!.message).toContain(
      "Unterminated"
    )
  })

  it("reads ${file:/abs/path} once and trims one trailing newline", () => {
    const files = { "/run/secrets/idp": "file-secret\n" }
    const result = subst(
      { a: "${file:/run/secrets/idp}", b: "${file:/run/secrets/idp}" },
      files
    )
    expect(result.issues).toEqual([])
    expect(result.value).toEqual({ a: "file-secret", b: "file-secret" })
  })

  it("rejects a relative ${file:…} path", () => {
    expect(subst({ a: "${file:secrets/idp}" }).issues[0]!.message).toContain(
      "absolute path"
    )
  })

  it("reports an unreadable secret file without leaking the path contents", () => {
    const issue = subst({ a: "${file:/missing}" }).issues[0]!
    expect(issue.message).toContain("Cannot read secret file")
  })

  it("escapes a literal ${ with $${", () => {
    const result = subst({ a: "$${env:IDP_SECRET}" })
    expect(result.issues).toEqual([])
    expect(result.value).toEqual({ a: "${env:IDP_SECRET}" })
    expect([...result.placeholderPointers]).toEqual([])
  })

  it("substitutes embedded placeholders but does not mark them for coercion", () => {
    const result = subst({ url: "https://${env:IDP_SECRET}.example.com" })
    expect(result.value).toEqual({
      url: "https://super-secret-value.example.com",
    })
    expect([...result.placeholderPointers]).toEqual([])
  })

  it("is a single non-recursive pass", () => {
    const result = substitutePlaceholders(
      "config.json",
      { a: "${env:OUTER}" },
      {
        env: { OUTER: "${env:IDP_SECRET}", IDP_SECRET: "leaked" },
      }
    )
    expect(result.value).toEqual({ a: "${env:IDP_SECRET}" })
  })

  it("never substitutes into object keys", () => {
    const result = subst({ "${env:IDP_SECRET}": "value" })
    expect(result.value).toEqual({ "${env:IDP_SECRET}": "value" })
  })

  it("walks arrays and records array pointers", () => {
    const result = subst({ list: ["${env:IDP_SECRET}", "plain"] })
    expect(result.value).toEqual({ list: ["super-secret-value", "plain"] })
    expect([...result.placeholderPointers]).toEqual(["/list/0"])
  })

  it("leaves non-string scalars alone", () => {
    const result = subst({ n: 42, b: true, nil: null })
    expect(result.value).toEqual({ n: 42, b: true, nil: null })
  })

  it("marks placeholder-only strings so the schema can coerce them to the declared type", () => {
    const result = subst({
      port: "${env:IDP_PORT}",
      flag: "${env:IDP_FLAG}",
      list: "${env:IDP_LIST}",
    })
    expect([...result.coercedPointers].sort()).toEqual([
      "/flag",
      "/list",
      "/port",
    ])
  })

  it("does not treat a value that fell back to an inline default as env-supplied", () => {
    // An inline `:-default` is literal text sitting in the config file, so it
    // must not satisfy the CFG-5 production-secret rule — otherwise
    // `${env:SECRET:-hunter2}` would smuggle a hard-coded secret past it.
    const result = subst({
      resolved: "${env:IDP_SECRET}",
      fallback: "${env:MISSING:-hunter2}",
    })
    expect(result.issues).toEqual([])
    expect([...result.placeholderPointers]).toEqual(["/resolved"])
    // It is still a single placeholder, so type coercion still applies.
    expect([...result.coercedPointers].sort()).toEqual([
      "/fallback",
      "/resolved",
    ])
  })

  it("treats a secret file as an env-supplied source", () => {
    const result = subst(
      { a: "${file:/run/secrets/idp}" },
      { "/run/secrets/idp": "x" }
    )
    expect([...result.placeholderPointers]).toEqual(["/a"])
  })
})
