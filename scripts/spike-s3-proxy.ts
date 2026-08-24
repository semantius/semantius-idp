/**
 * Spike S3: the reverse proxy that stands in for Caddy's sub-path vhost.
 *
 * It forwards `<mount>/*` **without stripping the prefix**, which is what
 * `Caddyfile.subpath` will do (M12): the IdP is told its issuer is
 * `http://host:port/idp` and must serve that path itself. Anything outside the
 * mount answers 404, so a leaked host-root URL — an asset, a server-function
 * call, a `<Link>` that forgot the base path — fails here exactly as it would
 * behind a proxy that owns `/` for a different app.
 *
 *   bun scripts/spike-s3-proxy.ts --port 3100 --mount /idp --target http://127.0.0.1:3001
 */

function arg(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (Bun.argv[index + 1] ?? fallback)
}

const port = Number(arg("port", "3100"))
const mount = arg("mount", "/idp")
const target = arg("target", "http://127.0.0.1:3001")

const server = Bun.serve({
  port,
  idleTimeout: 30,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`)) {
      return new Response(`not proxied: ${url.pathname}\n`, { status: 404 })
    }
    const upstream = new URL(url.pathname + url.search, target)
    return fetch(upstream, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      // Bun requires this for a streamed request body.
      ...{ duplex: "half" },
    })
  },
})

console.log(`proxying http://localhost:${server.port}${mount} -> ${target}`)
