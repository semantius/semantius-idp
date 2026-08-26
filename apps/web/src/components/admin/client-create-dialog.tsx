import { useCallback, useState } from "react"
import type { ComponentProps } from "react"

import { Checkbox } from "@workspace/ui/components/checkbox"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { NativeSelect } from "@workspace/ui/components/native-select"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field"

import { ActionDialog } from "@/components/common/dialogs"
import { FieldError } from "@/components/auth/form-parts"
import { PendingForm, SubmitButton } from "@/components/common/pending-form"
import { CLIENT_ID_PATTERN, validateClientForm } from "@/lib/client-rules"
import type { ClientFormErrors } from "@/lib/client-rules"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * "Add an application" (FR-OIDC-2, **D50**, **D62**).
 *
 * Lifted out of `routes/admin/clients.tsx` when it grew validation and draft
 * restoration: the route is a table with three POST actions, and this is a
 * twelve-field form with rules of its own.
 *
 * Two halves of the same finding, and they meet here:
 *
 * - **Everything the browser can decide, it decides.** The rules are
 *   `lib/client-rules.ts`, shared with the zod schema that validates
 *   `oauth_clients.jsonc`, so the form refuses exactly what the server would —
 *   inline, against the field, without a round trip. The server check is
 *   untouched; this is the earlier of two gates.
 * - **What does reach the server survives its refusal.** A duplicate client
 *   id, a file-managed collision or a lost race comes back as
 *   `?error=…&draft=<handle>`; the loader claims the draft and the fields
 *   arrive here as `defaultValue`s with the dialog reopened.
 */
export function ClientCreateDialog({
  ui,
  t,
  draft,
  reopen,
}: {
  ui: UiContext
  t: Catalog
  /** The refused submission, claimed by the loader. */
  draft?: Draft
  /** Open on first paint — a refusal happened and its message is in here. */
  reopen?: boolean
}) {
  const { onSubmit, errors } = useClientForm()
  const values: Draft = draft ?? {}
  const value = (name: string): string | undefined => values[name]
  // A checkbox is absent from a form body when it is unticked, so a draft
  // cannot say "not ticked" by lookup alone — the presence of *any* field is
  // what says a draft was restored, and only then does an absent checkbox
  // mean the administrator had unticked it.
  const restored = Object.keys(values).length > 0
  const checked = (name: string, fallback: boolean) =>
    restored ? values[name] === "on" : fallback
  // Stashed as one entry per line, like the URI textareas, so a scope that is
  // a prefix of another cannot match by accident.
  const draftScopes = (values.scopes ?? "").split("\n")

  return (
    <ActionDialog
      label={t.admin.clients.add}
      description={t.admin.clients.addHelp}
      variant="default"
      size="default"
      defaultOpen={reopen}
    >
      <PendingForm
        busy={t.common.loading}
        method="post"
        className="grid gap-4"
        onSubmit={onSubmit}
      >
        <input type="hidden" name="action" value="create" />
        <Field>
          <FieldLabel htmlFor="name">{t.admin.clients.name}</FieldLabel>
          <Input
            id="name"
            name="name"
            required
            defaultValue={value("name")}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? "name-error" : undefined}
          />
          <FieldError id="name-error">
            {errors.name ? t.admin.clients.nameRequired : undefined}
          </FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="clientId">
            {t.admin.clients.clientId}
          </FieldLabel>
          <Input
            id="clientId"
            name="clientId"
            required
            autoComplete="off"
            pattern={CLIENT_ID_PATTERN}
            defaultValue={value("clientId")}
            aria-invalid={errors.clientId ? true : undefined}
            aria-describedby={errors.clientId ? "clientId-error" : undefined}
          />
          <FieldError id="clientId-error">
            {errors.clientId ? t.admin.clients.invalidClientId : undefined}
          </FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="type">{t.admin.clients.type}</FieldLabel>
          {/* SPA first and by default: a browser application is what an
              operator adds here, and PKCE is mandatory in this provider
              either way (FR-OIDC-1), so "web" only buys a secret that a
              single-page app cannot keep. */}
          <NativeSelect
            id="type"
            name="type"
            defaultValue={value("type") ?? "spa"}
            className="w-full"
          >
            <option value="spa">{t.admin.clients.typeSpa}</option>
            <option value="web">{t.admin.clients.typeWeb}</option>
            <option value="native">{t.admin.clients.typeNative}</option>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="redirectUris">
            {t.admin.clients.redirectUris}
          </FieldLabel>
          <Textarea
            id="redirectUris"
            name="redirectUris"
            required
            rows={3}
            className="font-mono text-xs"
            defaultValue={value("redirectUris")}
            aria-describedby={
              errors.redirectUris ? "redirectUris-error" : "redirect-help"
            }
            aria-invalid={errors.redirectUris ? true : undefined}
          />
          <FieldDescription id="redirect-help">
            {t.admin.clients.onePerLine}
          </FieldDescription>
          <FieldError id="redirectUris-error">
            {uriMessage(t, errors.redirectUris)}
          </FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="postLogoutRedirectUris">
            {t.admin.clients.postLogoutRedirectUris}
          </FieldLabel>
          {/* Read by the handler since D50 and never rendered, so every
              client created here got an empty list. */}
          <Textarea
            id="postLogoutRedirectUris"
            name="postLogoutRedirectUris"
            rows={2}
            className="font-mono text-xs"
            defaultValue={value("postLogoutRedirectUris")}
            aria-describedby={
              errors.postLogoutRedirectUris
                ? "postLogoutRedirectUris-error"
                : "post-logout-help"
            }
            aria-invalid={errors.postLogoutRedirectUris ? true : undefined}
          />
          <FieldDescription id="post-logout-help">
            {t.admin.clients.onePerLine}
          </FieldDescription>
          <FieldError id="postLogoutRedirectUris-error">
            {uriMessage(t, errors.postLogoutRedirectUris)}
          </FieldError>
        </Field>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">
            {t.admin.clients.scopes}
          </legend>
          {ui.oauthScopes.map((scope) => (
            <Label
              key={scope}
              className="flex items-center gap-2 text-sm font-normal"
            >
              {/* The wrapping label is Base UI's documented pattern and
                  is what makes the text a click target; `aria-label` is
                  belt-and-braces, because the control the user operates is
                  a `role="checkbox"` span rather than a labelable element,
                  and only labelable elements are named by a wrapping
                  `<label>` per HTML-AAM. */}
              <Checkbox
                name="scopes"
                value={scope}
                defaultChecked={
                  restored ? draftScopes.includes(scope) : true
                }
                aria-label={scope}
              />
              {scope}
            </Label>
          ))}
        </fieldset>
        {/* Asked the way round an administrator thinks about it (round 3,
            finding 10): *does this application ask the user?* The wire field
            is still `skipConsent`, inverted once in `skipConsentFromForm`,
            which has a test on it — this is a real triple negative in the
            making and the one place it is allowed to live.

            Unticked by default, which is `skipConsent: true`: FR-OIDC-3's
            documented default and what a file-declared client gets. The
            history is worth keeping, because the shape of the bug is easy to
            recreate: both checkboxes were once sent by the handler with no
            field to send them from, so a *defined* `false` overrode the
            schema default every time and every admin-registered client
            wrongly asked for consent. */}
        <Label className="flex items-start gap-2 text-sm font-normal">
          {/* `aria-describedby`, not just visible text: the control is a
              `role="checkbox"` span, so neither the wrapping label nor the
              help underneath it reaches a screen reader on its own. */}
          <Checkbox
            name="requireConsent"
            value="on"
            defaultChecked={checked("requireConsent", false)}
            aria-label={t.admin.clients.requireConsentLabel}
            aria-describedby="require-consent-help"
          />
          <span>
            {t.admin.clients.requireConsentLabel}
            <span
              id="require-consent-help"
              className="block text-xs text-muted-foreground"
            >
              {t.admin.clients.requireConsentHelp}
            </span>
          </span>
        </Label>
        {/* Unchecked, unlike `skipConsent`: `clients-schema.ts` refuses
            `enableEndSession: true` with no post-logout URI, so defaulting
            it on would fail every plain create. The old always-false bug
            was accidentally load-bearing. */}
        <Label className="flex items-start gap-2 text-sm font-normal">
          <Checkbox
            name="enableEndSession"
            value="on"
            defaultChecked={checked("enableEndSession", false)}
            aria-label={t.admin.clients.enableEndSession}
            aria-describedby="end-session-help"
          />
          <span>
            {t.admin.clients.enableEndSession}
            <span
              id="end-session-help"
              className="block text-xs text-muted-foreground"
            >
              {t.admin.clients.enableEndSessionHelp}
            </span>
          </span>
        </Label>
        <SubmitButton>{t.admin.clients.add}</SubmitButton>
      </PendingForm>
    </ActionDialog>
  )
}

/** Whatever React's own `<form onSubmit>` is typed as, in this React. */
type FormSubmitEvent = Parameters<
  NonNullable<ComponentProps<"form">["onSubmit"]>
>[0]

/**
 * The submit-time check, reading values straight out of the form.
 *
 * Uncontrolled inputs throughout, so the fields keep their `defaultValue`
 * behaviour and a restored draft is not fighting React state.
 */
function useClientForm(): {
  onSubmit: (event: FormSubmitEvent) => void
  errors: ClientFormErrors
} {
  const [errors, setErrors] = useState<ClientFormErrors>({})

  const onSubmit = useCallback((event: FormSubmitEvent) => {
    const form = event.currentTarget
    const read = (name: string): string => {
      const field = form.elements.namedItem(name)
      return field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
        ? field.value
        : ""
    }
    const ticked = (name: string): boolean => {
      // Queried rather than taken from `form.elements`: the control the user
      // operates is a Base UI `role="checkbox"` span, and the thing that
      // actually carries the state is the hidden input behind it. Asking the
      // named collection can hand back the span instead, and a `false` from
      // that would silently switch this rule off.
      const field = form.querySelector(`input[name="${name}"]`)
      return field instanceof HTMLInputElement ? field.checked : false
    }

    const found = validateClientForm({
      clientId: read("clientId"),
      name: read("name"),
      type: read("type"),
      redirectUris: read("redirectUris"),
      postLogoutRedirectUris: read("postLogoutRedirectUris"),
      enableEndSession: ticked("enableEndSession"),
    })

    setErrors(found)
    if (Object.keys(found).length === 0) return

    event.preventDefault()
    // Focus the first field with a problem, or the message is announced with
    // no way to reach what it is about.
    for (const name of [
      "name",
      "clientId",
      "redirectUris",
      "postLogoutRedirectUris",
    ] as const) {
      if (!found[name]) continue
      const field = form.elements.namedItem(name)
      if (field instanceof HTMLElement) field.focus()
      return
    }
  }, [])

  return { onSubmit, errors }
}

/**
 * Turns a `uri:<problem>:<value>` code into a catalog sentence.
 *
 * The offending URI is carried in the code rather than in the message,
 * because wording never leaves the catalog (FR-I18N-1).
 */
function uriMessage(t: Catalog, code: string | undefined): string | undefined {
  if (!code) return undefined
  if (code === "required") return t.admin.clients.redirectRequired
  if (code === "endSessionNeedsUri") return t.admin.clients.endSessionNeedsUri
  const [, problem = "", ...rest] = code.split(":")
  const uri = rest.join(":")
  switch (problem) {
    case "wildcard":
      return t.admin.clients.uriWildcard(uri)
    case "not_absolute":
      return t.admin.clients.uriNotAbsolute(uri)
    case "fragment":
      return t.admin.clients.uriFragment(uri)
    case "http_not_loopback":
      return t.admin.clients.uriHttp(uri)
    case "private_scheme":
      return t.admin.clients.uriPrivateScheme(uri)
    default:
      return undefined
  }
}
