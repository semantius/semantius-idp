import { createFileRoute } from "@tanstack/react-router"

/**
 * `/robots.txt` — disallow everything (FR-OIDC-15).
 *
 * An identity provider has nothing to index, and a sign-in page in search
 * results only helps phishing. `__root.tsx` repeats it as a meta tag for
 * crawlers that arrive at a page directly.
 *
 * This is a route rather than a file in `public/`, because the scaffold's
 * `public/robots.txt` allowed everything and a static file would shadow a
 * route at the same path — which is exactly what it did until this landed.
 */
const BODY = `User-agent: *
Disallow: /
`

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(BODY, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=86400",
          },
        }),
    },
  },
})
