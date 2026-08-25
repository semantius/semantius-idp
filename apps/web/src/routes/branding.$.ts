import { createFileRoute } from "@tanstack/react-router"

import { serveBrandingFile } from "@/server/branding"

/**
 * The operator's logo and favicon, out of the config folder (CFG-1).
 *
 * `site.logo` and `site.favicon` name files the deployment supplies, and the
 * only place a read-only container has them is the folder already mounted at
 * `/config`. So `/branding/logo.svg` is `${IDP_CONFIG_DIR}/branding/logo.svg`,
 * and nothing has to be baked into the image for a deployment to be branded.
 *
 * **It is a file server pointed at operator-controlled input**, so every rule
 * lives in `server/branding.ts` where it can be tested without a router: the
 * traversal guard, the extension allow-list, and the refusal to guess a
 * content type. This route is the mounting, not the policy.
 */
export const Route = createFileRoute("/branding/$")({
  server: {
    handlers: {
      GET: ({ params }) => serveBrandingFile(params._splat ?? ""),
    },
  },
})
