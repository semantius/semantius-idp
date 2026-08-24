import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router"

import appCss from "@workspace/ui/globals.css?url"

import { fetchUiContext } from "@/server/functions/ui"
import { getCatalog } from "@/server/i18n"

/**
 * The document every page is rendered into.
 *
 * Branding, locale and theme all come from configuration, resolved on the
 * server, so the first paint is already correct — no flash of the wrong theme
 * and no untranslated shell (FR-ACCT-2, FR-I18N-1).
 *
 * `robots.txt` disallows everything (FR-OIDC-15) and the meta tag repeats it
 * for crawlers that arrive at a page directly: an IdP has nothing to index and
 * a sign-in page in search results only helps phishing.
 */
export const Route = createRootRoute({
  // `beforeLoad` rather than `loader`, so the value lands in the router
  // context and every child route reads it from there — one RPC per
  // navigation, not one per matched route.
  beforeLoad: async () => ({ ui: await fetchUiContext() }),
  loader: ({ context }) => ({ ui: context.ui }),
  head: ({ loaderData }) => {
    const ui = loaderData?.ui
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "robots", content: "noindex, nofollow" },
        {
          name: "color-scheme",
          content:
            ui?.theme === "system" ? "light dark" : (ui?.theme ?? "light"),
        },
        { title: ui?.siteName ?? "Identity provider" },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        ...(ui?.logo ? [{ rel: "icon", href: ui.logo }] : []),
      ],
    }
  },
  notFoundComponent: NotFound,
  errorComponent: ErrorPage,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { ui } = Route.useLoaderData()
  return (
    <html lang={ui.locale} className={ui.theme === "dark" ? "dark" : undefined}>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

/** 404 (FR-ACCT-2). Says nothing about what does exist. */
function NotFound() {
  const t = getCatalog()
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold">{t.errors.notFound.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t.errors.notFound.description}
      </p>
    </main>
  )
}

/** 500 (FR-ACCT-2). No stack, no message from the error itself. */
function ErrorPage() {
  const t = getCatalog()
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold">{t.errors.serverError.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t.errors.serverError.description}
      </p>
    </main>
  )
}
