/**
 * RFC 6238 TOTP, for tests that have to answer a real 2FA challenge.
 *
 * Written out rather than pulled from Better Auth's own `@better-auth/utils`:
 * a test that generates codes with the same helper the server verifies them
 * with would pass even if both agreed on something wrong. Twenty lines of
 * HMAC is a cheap independent implementation.
 */

import { createHmac } from "node:crypto"

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** Pulls the base32 `secret` out of an `otpauth://` URI. */
export function secretFromTotpUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret")
  if (!secret) throw new Error(`No secret in TOTP URI: ${uri}`)
  return secret
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "").toUpperCase()
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of clean) {
    const value = BASE32_ALPHABET.indexOf(character)
    if (value === -1) throw new Error(`Not base32: ${character}`)
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

/** The six-digit code for `now`, from a base32 secret. */
export function totpCode(
  base32Secret: string,
  { digits = 6, period = 30, now = Date.now() } = {}
): string {
  const counter = Math.floor(now / 1000 / period)
  const message = Buffer.alloc(8)
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  message.writeUInt32BE(counter >>> 0, 4)

  const digest = createHmac("sha1", Buffer.from(base32Decode(base32Secret)))
    .update(message)
    .digest()

  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!

  return String(binary % 10 ** digits).padStart(digits, "0")
}
