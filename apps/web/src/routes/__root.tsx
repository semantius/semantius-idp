import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router"

import appCss from "@workspace/ui/globals.css?url"
import { Toaster } from "@workspace/ui/components/toast"

import { BASE_PATH_ATTRIBUTE, assetUrl } from "@/lib/base-path"
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
        { rel: "stylesheet", href: assetUrl(appCss) },
        ...(ui?.favicon ? [{ rel: "icon", href: ui.favicon }] : []),
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
    <html
      lang={ui.locale}
      className={ui.theme === "dark" ? "dark" : undefined}
      // How the mount path reaches the browser bundle (OPS-10, spike S3):
      // already parsed by the time the client entry builds its router.
      {...{ [BASE_PATH_ATTRIBUTE]: ui.basePath }}
    >
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        {/*
          One toast host for the whole application (**D71**). Success notices
          arrive as `?notice=<code>` on the page a 303 lands on, so any of them
          could be the one that has something to say — mounting the provider
          per page would mean remembering to, and forgetting on the eight that
          matter. It renders nothing until a `NoticeToast` adds something.
        */}
        <Toaster />
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
