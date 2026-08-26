import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * "You are signed in as somebody else", with a way out (FR-ADMIN-5, **D66**).
 *
 * The banner was on both shells already, in duplicate, and it said what was
 * happening without offering to stop it — so an impersonation ended by
 * expiring after an hour or by signing out, which signs the *administrator*
 * out too. That is also why `impersonation.stopped` was declared in SEC-6 and
 * never written by anything: nothing ever called the endpoint that produces
 * it.
 *
 * A form rather than a link, because it changes a session: a GET that ends an
 * impersonation could be triggered by an `<img>` tag on any page the
 * impersonated user visits. The row is written by the guard's hook, like every
 * other `/admin/*` write.
 */
export function ImpersonationBanner({
  ui,
  t,
}: {
  ui: UiContext
  t: Catalog
}) {
  return (
    <div
      role="status"
      className="text-destructive-foreground bg-destructive px-4 py-2 text-center text-sm font-medium"
    >
      <span className="mr-3">{t.account.impersonationBanner}</span>
      <PendingForm
        busy={t.common.loading}
        method="post"
        action={`${ui.basePath}/stop-impersonating`}
        className="inline"
      >
        <SubmitButton
          variant="outline"
          size="sm"
          // The banner is `bg-destructive`, so the kit's outline button —
          // which assumes a page background — would be invisible on it.
          className="border-destructive-foreground/40 bg-transparent text-destructive-foreground hover:bg-destructive-foreground/10"
        >
          {t.account.stopImpersonating}
        </SubmitButton>
      </PendingForm>
    </div>
  )
}
