/**
 * Which address the request actually came from.
 *
 * `X-Forwarded-For` is a list that anyone can prepend to. A client that sends
 * `X-Forwarded-For: 1.2.3.4` and then goes through one proxy arrives as
 * `1.2.3.4, <their real address>` — so **the leftmost entry is the one under
 * the attacker's control** and the rightmost is the one the nearest proxy
 * observed. Reading the left is the classic way to make a rate limiter and an
 * audit trail agree on a lie.
 *
 * So the rule here is **rightmost-untrusted-hop**: walk the list from the
 * right, discarding hops that are trusted proxies, and take the first address
 * that is not. That address is the furthest point back that a trusted
 * component actually vouched for. With `trustProxy: false` the header is not
 * consulted at all and the socket address is the answer.
 *
 * `server.trustProxy` is either a boolean or a list of CIDRs:
 *
 *  - `false` — no header is trusted. The default, and correct for a server
 *    exposed directly.
 *  - `true` — every hop is trusted, so the *leftmost* entry is returned. This
 *    is the standard meaning and it is only safe when nothing but the proxy can
 *    reach the port. The module says so; the configuration reference repeats it.
 *  - `["10.0.0.0/8", …]` — hops inside those ranges are trusted and skipped;
 *    the first one outside is the client.
 *
 * IPv4 and IPv6 both, including the `::ffff:1.2.3.4` form a dual-stack socket
 * reports and the `[2001:db8::1]:443` form a proxy may write.
 */

/**
 * The private header that carries the caller's address between the layers.
 *
 * Two writers, in order: `src/serve.ts` stamps the **socket** address into it,
 * and `src/server-entry.ts` then overwrites it with the address
 * {@link resolveClientAddress} resolved from that socket and the forwarded
 * chain under `server.trustProxy`. Everything downstream — Better Auth's rate
 * limiter through `advanced.ipAddress.ipAddressHeaders`, the gateway proxy,
 * the audit trail — reads the resolved value and nothing re-resolves it
 *.
 *
 * It lives here rather than in `src/server-entry.ts` because very different
 * modules need the name — the edge that writes it and the Better Auth options
 * that read it — and importing the Start entry into the auth instance would
 * drag the whole framework handler along with it.
 *
 * **Always overwritten by the layer that sets it**, never merged, so a client
 * sending one of its own has it erased before anything reads it.
 */
export const SOCKET_ADDRESS_HEADER = "x-idp-socket-address"

/** What `server.trustProxy` can be. */
export type TrustProxy = boolean | readonly string[]

export interface ClientIpOptions {
  /** The socket address, when the runtime can supply one. */
  socketAddress?: string | null
  /** Header to read instead of `x-forwarded-for`, if the deployment uses one. */
  header?: string
}

/**
 * The client's address, or `undefined` when nothing reliable is available.
 *
 * `undefined` is a real answer and callers must handle it: a runtime that
 * cannot report a socket address, with `trustProxy: false`, genuinely does not
 * know who is calling — and a rate limiter that invents an address in that
 * case buckets the whole world together.
 */
export function clientIpFrom(
  request: Request,
  trustProxy: TrustProxy,
  { socketAddress, header = "x-forwarded-for" }: ClientIpOptions = {}
): string | undefined {
  const direct = normalizeIp(socketAddress)

  if (trustProxy === false) return direct

  const forwarded = request.headers.get(header)
  if (!forwarded) return direct

  const hops = forwarded
    .split(",")
    .map((hop) => normalizeIp(hop))
    .filter((hop): hop is string => hop !== undefined)
  if (hops.length === 0) return direct

  // `true` means "every hop in front of me is mine", so the far end of the
  // chain is the client. Only correct when nothing else can reach the port.
  if (trustProxy === true) return hops[0]

  // A CIDR list: walk from the right, skipping hops we put there ourselves.
  // The socket address counts as a hop too — it is the one we can see.
  const chain = direct ? [...hops, direct] : hops
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const hop = chain[index]!
    if (!isTrusted(hop, trustProxy)) return hop
  }

  // Every hop was a trusted proxy, which means the chain never reached a
  // client — a misconfiguration rather than a request. The leftmost is the
  // closest thing to an answer, and it is at least one of ours.
  return chain[0]
}

/**
 * Resolves the caller's address **once**, at the edge, and writes the answer
 * back into {@link SOCKET_ADDRESS_HEADER} so every later reader sees the same
 * address whatever `server.trustProxy` is.
 *
 * Before this, two resolvers disagreed. `clientIpFrom` read the leftmost hop
 * under `trustProxy: true`; Better Auth's own `getIP`, handed
 * `x-forwarded-for` with no `trustedProxies`, trusts a *single-valued* header
 * only and answers `null` for a chain — so behind two hops (Traefik → Caddy,
 * the sibling deployment's shape) every user of the deployment shared one
 * `no-trusted-ip` bucket, and the spec's ten sign-in attempts a minute became a
 * ten-a-minute lockout of everybody. One resolution, written to one header
 * the edge always overwrites, is what makes the two agree — and it keeps
 * `true` meaning "leftmost", which the sibling depends on.
 *
 * The returned request is a copy with the header rewritten; the forwarded
 * chain itself is left in place for anything that still wants to read it.
 * When nothing resolves the header is *removed*, so no reader can mistake a
 * stale or client-supplied value for an answer.
 */
export function resolveClientAddress(
  request: Request,
  trustProxy: TrustProxy
): { request: Request; ipAddress: string | undefined } {
  const ipAddress = clientIpFrom(request, trustProxy, {
    socketAddress: request.headers.get(SOCKET_ADDRESS_HEADER),
  })
  const headers = new Headers(request.headers)
  if (ipAddress) headers.set(SOCKET_ADDRESS_HEADER, ipAddress)
  else headers.delete(SOCKET_ADDRESS_HEADER)
  return { request: copyWithHeaders(request, headers), ipAddress }
}

/**
 * A copy of `request` carrying `headers`, built from its parts.
 *
 * **Not `new Request(request)`**, which is what this was, and which broke
 * every page under `vite dev`. There the request is srvx's `NodeRequest`: it
 * passes `instanceof Request` because srvx sets its prototype to the native
 * one, but it has none of undici's internal state, so Node's constructor reads
 * a slot that is not there and throws `Cannot read properties of undefined
 * (reading 'window')` — at the edge, before anything else runs. Bun's server
 * hands over a native Request, which is why the image never showed it, and no
 * gate sent a page through the dev server until `dev-server.test.ts` did.
 *
 * The body is streamed across, not read: `duplex: "half"` is what Node needs
 * to accept a stream, and Bun ignores it. Nothing reads the original's body
 * afterwards — the entry hands `inbound` to the handler.
 */
function copyWithHeaders(request: Request, headers: Headers): Request {
  const hasBody =
    request.body !== null &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  }
  return new Request(request.url, init)
}

/**
 * The address as a rate-limit key: IPv4 verbatim, IPv6 masked to its /64
 *.
 *
 * A residential or cloud IPv6 allocation is a /64 at the smallest, so the low
 * 64 bits are the caller's to rotate through — 2^64 addresses that never
 * share a bucket is no bucket at all (the GHSA-p6v2 class). Better Auth masks
 * its own keys the same way (`advanced.ipAddress.ipv6Subnet`); this is the
 * same rule for the buckets the IdP keys itself, `/setup` and the token
 * endpoint's per-address one. **Rate-limit keys only**: the audit trail and
 * the request log anonymize separately (`logger.ts`) and never read this.
 */
export function rateLimitKeyAddress(
  value: string | null | undefined
): string | undefined {
  const ip = normalizeIp(value)
  if (!ip) return undefined
  const bytes = toBytes(ip)
  if (!bytes || bytes.length === 4) return ip
  const groups: string[] = []
  for (let index = 0; index < 4; index += 1) {
    groups.push(((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16))
  }
  return `${groups.join(":")}::/64`
}

/** Whether an address falls inside any of the trusted ranges. */
export function isTrusted(ip: string, ranges: readonly string[]): boolean {
  return ranges.some((range) => inCidr(ip, range))
}

/**
 * Membership of a CIDR block, for v4 and v6.
 *
 * A bare address (no `/`) is treated as a /32 or /128 — an operator who lists
 * one proxy by address means that proxy, and making them write `/32` would be
 * a trap rather than a clarification.
 */
export function inCidr(ip: string, range: string): boolean {
  const [network, bitsText] = range.split("/")
  if (!network) return false

  const target = toBytes(ip)
  const base = toBytes(network)
  if (!target || !base) return false
  // A v4 address is never inside a v6 range, or the reverse.
  if (target.length !== base.length) return false

  const bits = bitsText === undefined ? base.length * 8 : Number(bitsText)
  if (!Number.isInteger(bits) || bits < 0 || bits > base.length * 8) {
    return false
  }

  const wholeBytes = Math.floor(bits / 8)
  for (let index = 0; index < wholeBytes; index += 1) {
    if (target[index] !== base[index]) return false
  }
  const remaining = bits % 8
  if (remaining === 0) return true
  const mask = 0xff << (8 - remaining)
  return (target[wholeBytes]! & mask) === (base[wholeBytes]! & mask)
}

/**
 * Trims an address to its bare form.
 *
 * Three shapes turn up in the wild and all three have to become the same
 * string, or a CIDR check silently answers "not trusted" for an address that
 * is: `::ffff:10.0.0.1` from a dual-stack socket, `[2001:db8::1]:443` from a
 * proxy that wrote a port, and `10.0.0.1:5000` from one that wrote a port on a
 * v4 address.
 */
export function normalizeIp(
  value: string | null | undefined
): string | undefined {
  if (!value) return undefined
  let ip = value.trim()
  if (ip === "") return undefined

  // `[2001:db8::1]:443` or `[2001:db8::1]`
  if (ip.startsWith("[")) {
    const close = ip.indexOf("]")
    if (close === -1) return undefined
    ip = ip.slice(1, close)
  } else if (ip.includes(".") && ip.includes(":")) {
    // `10.0.0.1:5000` — a v4 address with a port. A v4-mapped v6 address also
    // has both, so only strip when there is exactly one colon.
    const colons = ip.split(":").length - 1
    if (colons === 1) ip = ip.slice(0, ip.indexOf(":"))
  }

  // `::ffff:10.0.0.1` is 10.0.0.1 wearing a hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) ip = mapped[1]!

  return toBytes(ip) ? ip : undefined
}

/** The address as bytes: 4 for v4, 16 for v6. `undefined` if it is neither. */
function toBytes(ip: string): Uint8Array | undefined {
  if (ip.includes(".") && !ip.includes(":")) return v4Bytes(ip)
  if (ip.includes(":")) return v6Bytes(ip)
  return undefined
}

function v4Bytes(ip: string): Uint8Array | undefined {
  const parts = ip.split(".")
  if (parts.length !== 4) return undefined
  const bytes = new Uint8Array(4)
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index]!
    // No leading zeros, and only plain decimal digits. `010.0.0.1` is not a
    // pedantic case: some parsers read a leading zero as octal, so accepting
    // it means this code and the next component along disagree about which
    // address they are looking at — which is how a trusted-range check gets
    // talked into saying yes.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    bytes[index] = value
  }
  return bytes
}

function v6Bytes(ip: string): Uint8Array | undefined {
  // A trailing v4 part (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) becomes two
  // groups so the rest of the parser only has to think in hextets.
  let text = ip
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const four = v4Bytes(tail[1]!)
    if (!four) return undefined
    const high = ((four[0]! << 8) | four[1]!).toString(16)
    const low = ((four[2]! << 8) | four[3]!).toString(16)
    text = `${text.slice(0, tail.index)}${high}:${low}`
  }

  const halves = text.split("::")
  if (halves.length > 2) return undefined

  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":")
  const tailGroups =
    halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : []

  if (halves.length === 1 && head.length !== 8) return undefined
  if (head.length + tailGroups.length > 8) return undefined

  const groups = [
    ...head,
    ...new Array<string>(8 - head.length - tailGroups.length).fill("0"),
    ...tailGroups,
  ]

  const bytes = new Uint8Array(16)
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index]!
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = value >> 8
    bytes[index * 2 + 1] = value & 0xff
  }
  return bytes
}
