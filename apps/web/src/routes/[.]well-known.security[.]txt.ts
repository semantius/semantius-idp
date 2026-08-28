import { createFileRoute } from "@tanstack/react-router"

import { readSecurityTxt } from "@/server/functions/security-txt"

/**
 * `/.well-known/security.txt` (RFC 9116, FR-OIDC-15).
 *
 * Served **only** when a `security.txt` file exists in the config folder. The
 * spec says the contents come "from config", and the reading taken here is the
 * literal one: an operator drops the file in beside `config.jsonc` and it is
 * served verbatim; otherwise the path 404s.
 *
 * The alternative — synthesising a document from `site.supportEmail` — would
 * publish a contact address the operator never chose to publish, and RFC 9116
 * documents are signed and dated in ways only their author can get right.
 */
export const Route = createFileRoute("/.well-known/security.txt")({
  server: {
    handlers: {
      GET: async () => {
        const body = await readSecurityTxt()
        // A plain 404, not `notFound()`: throwing that inside a server
        // handler leaves the Start handler with nothing to return, and the
        // runtime answers with its own default page — which is how this
        // endpoint came to serve "Welcome to Bun!" until it was tried.
        if (body === null) {
          return new Response(null, {
            status: 404,
            headers: { "cache-control": "no-store" },
          })
        }
        return new Response(body, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        })
      },
    },
  },
})
