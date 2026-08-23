import { describe, expect, it } from "vitest"

import { parseJsoncText, stripSchemaKey } from "@/server/config/jsonc"

describe("CFG-1 JSONC parsing", () => {
  it("accepts comments and trailing commas", () => {
    const text = `{
      // the issuer
      "server": { "baseUrl": "https://idp.example.com" }, /* block */
      "site": { "name": "IdP" },
    }`
    const result = parseJsoncText("config.json", text)
    expect(result.issues).toEqual([])
    expect(result.value).toEqual({
      server: { baseUrl: "https://idp.example.com" },
      site: { name: "IdP" },
    })
  })

  it("reports a syntax error with line and column", () => {
    const result = parseJsoncText("config.json", '{\n  "a": 1\n  "b": 2\n}')
    expect(result.value).toBeUndefined()
    expect(result.issues[0]!.message).toMatch(/line \d+, column \d+/)
    expect(result.issues[0]!.file).toBe("config.json")
  })

  it("rejects an empty file", () => {
    expect(parseJsoncText("config.json", "").issues[0]!.message).toContain(
      "empty"
    )
  })

  it("rejects a non-object top level", () => {
    expect(parseJsoncText("roles.json", "[1, 2]").issues[0]!.message).toContain(
      "Expected a JSON object"
    )
  })

  it("exempts $schema from the unknown-key rule by stripping it", () => {
    expect(
      stripSchemaKey({ $schema: "./config.schema.json", site: { name: "x" } })
    ).toEqual({
      site: { name: "x" },
    })
  })

  it("leaves documents without $schema untouched", () => {
    const value = { site: { name: "x" } }
    expect(stripSchemaKey(value)).toBe(value)
  })
})
