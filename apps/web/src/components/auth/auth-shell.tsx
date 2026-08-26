import type { ReactNode } from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"

import type { UiContext } from "@/server/ui-context"

/**
 * The frame every public page shares (FR-ACCT-2).
 *
 * Mobile-first, one column, and rendered entirely on the server so the login
 * form is present in the first paint rather than after hydration. Branding
 * comes from `site.*`; there are no third-party origins, so the CSP can forbid
 * them outright (SEC-8).
 */
export function AuthShell({
  ui,
  title,
  description,
  children,
  footer,
  width = "sm",
}: {
  ui: UiContext
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: "sm" | "md"
}) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-muted/30 px-4 py-10">
      <div className={cn("w-full", width === "sm" ? "max-w-sm" : "max-w-md")}>
        <header className="mb-6 flex flex-col items-center gap-3 text-center">
          {ui.logo ? (
            <img
              src={ui.logo}
              alt=""
              className="h-10 w-auto"
              aria-hidden="true"
            />
          ) : null}
          <p className="text-sm font-medium text-muted-foreground">
            {ui.siteName}
          </p>
        </header>

        {/* The kit's Card, not a hand-rolled panel: the preset restyle moved
            the radius, the ring and the shadow, and this was the one surface
            still wearing the old ones. `h1` and the real heading level stay —
            e2e selectors and the axe pass both go through heading roles. */}
        <Card>
          <CardHeader>
            <CardTitle>
              <h1>{title}</h1>
            </CardTitle>
            {description ? (
              <CardDescription>{description}</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>

        {footer ? (
          <footer className="mt-4 text-center text-sm text-muted-foreground">
            {footer}
          </footer>
        ) : null}

        {(ui.termsUrl ?? ui.privacyUrl) ? (
          <p className="mt-6 text-center text-xs text-muted-foreground">
            {ui.termsUrl ? (
              <a className="underline underline-offset-4" href={ui.termsUrl}>
                Terms
              </a>
            ) : null}
            {ui.termsUrl && ui.privacyUrl ? (
              <span aria-hidden="true"> · </span>
            ) : null}
            {ui.privacyUrl ? (
              <a className="underline underline-offset-4" href={ui.privacyUrl}>
                Privacy
              </a>
            ) : null}
          </p>
        ) : null}
      </div>
    </main>
  )
}
