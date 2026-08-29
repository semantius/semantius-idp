import { useCallback, useId, useState } from "react"
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

import { AdminCard } from "@/components/admin/admin-shell"
import { FieldError } from "@/components/auth/form-parts"
import { CLIENT_ID_PATTERN, validateClientForm } from "@/lib/client-rules"
import type { ClientFormErrors } from "@/lib/client-rules"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"
import type { UiContext } from "@/server/ui-context"

/**
 * The twelve fields an OAuth client is described by, shared by the create and
 * edit **pages** (**D50**, **D62**, **D72**, **D93**).
 *
 * It was inline in `ClientCreateDialog` until editing arrived. Two forms
 * describing the same row from two field lists is how one of them ends up
 * missing a column, and `/idp/update-client` is a **full replace** — a field
 * the edit form does not render is a field every edit silently resets to its
 * schema default. Sharing the markup is what makes that impossible rather than
 * merely unlikely, and it is why **D93** moved both callers to routes without
 * touching this file's field list.
 *
 * **Three cards, and that — not width — is the fix for "hard to scroll"**
 * (**D93**). One column of twelve controls is one column of twelve controls at
 * any measure; `max-w-3xl` is a good line length for the URI textareas and a
 * poor one for stacked single-line inputs, which is what the Identity card's
 * two-column grid is for.
 *
 * **Every id is still generated** (`useId`). The reason changed and the rule
 * did not: there is one of these per page now rather than one per row, but
 * `name` is unique in a *form* and emphatically not in a document, and this is
 * shared markup that must not care which page mounted it. `name` still decides
 * what is submitted; only the id is generated.
 */
export interface ClientFormValues {
  name: string
  clientId: string
  type: string
  /** One URI per line, as the textarea holds it. */
  redirectUris: string
  postLogoutRedirectUris: string
  /** The ticked scopes, by name. */
  scopes: string[]
  requireConsent: boolean
  enableEndSession: boolean
}

/**
 * A restored draft wins over the fallback, field by field.
 *
 * The fallback is the built-in defaults for a create and **the row** for an
 * edit. A checkbox is absent from a form body when it is unticked, so a draft
 * cannot say "not ticked" by lookup alone: the presence of *any* field is what
 * says a draft was restored, and only then does an absent checkbox mean the
 * administrator had unticked it.
 */
export function resolveClientFormValues(
  draft: Draft | undefined,
  fallback: ClientFormValues
): ClientFormValues {
  const values: Draft = draft ?? {}
  const restored = Object.keys(values).length > 0
  if (!restored) return fallback

  const text = (name: string, or: string): string => values[name] ?? or
  const ticked = (name: string): boolean => values[name] === "on"

  return {
    name: text("name", fallback.name),
    clientId: text("clientId", fallback.clientId),
    type: text("type", fallback.type),
    redirectUris: text("redirectUris", fallback.redirectUris),
    postLogoutRedirectUris: text(
      "postLogoutRedirectUris",
      fallback.postLogoutRedirectUris
    ),
    // Stashed as one entry per line, like the URI textareas, so a scope that
    // is a prefix of another cannot match by accident.
    scopes: (values.scopes ?? "").split("\n").filter((scope) => scope !== ""),
    requireConsent: ticked("requireConsent"),
    enableEndSession: ticked("enableEndSession"),
  }
}

export function ClientFormFields({
  ui,
  t,
  values,
  errors,
  fixedClientId = false,
}: {
  ui: UiContext
  t: Catalog
  values: ClientFormValues
  errors: ClientFormErrors
  /**
   * The edit page. The client id is the natural key four other tables
   * reference, so it is shown and not editable — as text plus a hidden input,
   * because a `disabled` input contributes no name/value pair and the handler
   * would not know which application it was told to change.
   */
  fixedClientId?: boolean
}) {
  const id = useId()
  const field = (name: string) => `${id}-${name}`

  return (
    <>
      <AdminCard
        title={t.admin.clients.groupIdentity}
        description={t.admin.clients.groupIdentityHelp}
        className="gap-4"
      >
        {/* Two columns from `sm` up: the name and the client id are short
            single-line values, and stacking them is what made twelve controls
            read as a wall (**D93**). The textareas below stay full width,
            because a URI is long. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={field("name")}>
              {t.admin.clients.name}
            </FieldLabel>
            <Input
              id={field("name")}
              name="name"
              required
              defaultValue={values.name}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? field("name-error") : undefined}
            />
            <FieldError id={field("name-error")}>
              {errors.name ? t.admin.clients.nameRequired : undefined}
            </FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor={field("clientId")}>
              {t.admin.clients.clientId}
            </FieldLabel>
            {fixedClientId ? (
              <>
                <input type="hidden" name="clientId" value={values.clientId} />
                <code
                  id={field("clientId")}
                  className="block rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all"
                >
                  {values.clientId}
                </code>
                <FieldDescription id={field("clientId-help")}>
                  {t.admin.clients.clientIdFixed}
                </FieldDescription>
              </>
            ) : (
              <>
                <Input
                  id={field("clientId")}
                  name="clientId"
                  required
                  autoComplete="off"
                  pattern={CLIENT_ID_PATTERN}
                  defaultValue={values.clientId}
                  aria-invalid={errors.clientId ? true : undefined}
                  aria-describedby={
                    errors.clientId ? field("clientId-error") : undefined
                  }
                />
                <FieldError id={field("clientId-error")}>
                  {clientIdMessage(t, errors.clientId)}
                </FieldError>
              </>
            )}
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={field("type")}>
            {t.admin.clients.type}
          </FieldLabel>
          {/* SPA first and by default: a browser application is what an
            operator adds here, and PKCE is mandatory in this provider
            either way (FR-OIDC-1), so "web" only buys a secret that a
            single-page app cannot keep. */}
          <NativeSelect
            id={field("type")}
            name="type"
            defaultValue={values.type}
            className="w-full"
            aria-describedby={field("type-help")}
          >
            <option value="spa">{t.admin.clients.typeSpa}</option>
            <option value="web">{t.admin.clients.typeWeb}</option>
            <option value="native">{t.admin.clients.typeNative}</option>
          </NativeSelect>
          {/* **D78**: this control is the only thing that decides whether the
            application has a secret, and — on the edit page — the only way
            to give one to an application that has none. Neither was said
            anywhere, so registering the default type produced no secret, no
            rotate control on the row, and no explanation for either. The
            option labels carry the fact; this carries the consequence, and it
            is the same sentence on both pages because the transition it
            describes runs both ways. */}
          <FieldDescription id={field("type-help")}>
            {t.admin.clients.typeHelp}
          </FieldDescription>
        </Field>
      </AdminCard>

      <AdminCard
        title={t.admin.clients.groupRedirects}
        description={t.admin.clients.groupRedirectsHelp}
        className="gap-4"
      >
        <Field>
          <FieldLabel htmlFor={field("redirectUris")}>
            {t.admin.clients.redirectUris}
          </FieldLabel>
          <Textarea
            id={field("redirectUris")}
            name="redirectUris"
            required
            rows={3}
            className="font-mono text-xs"
            defaultValue={values.redirectUris}
            aria-describedby={
              errors.redirectUris
                ? field("redirectUris-error")
                : field("redirect-help")
            }
            aria-invalid={errors.redirectUris ? true : undefined}
          />
          <FieldDescription id={field("redirect-help")}>
            {t.admin.clients.onePerLine}
          </FieldDescription>
          <FieldError id={field("redirectUris-error")}>
            {uriMessage(t, errors.redirectUris)}
          </FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor={field("postLogoutRedirectUris")}>
            {t.admin.clients.postLogoutRedirectUris}
          </FieldLabel>
          {/* Read by the handler since D50 and never rendered, so every
            client created here got an empty list. */}
          <Textarea
            id={field("postLogoutRedirectUris")}
            name="postLogoutRedirectUris"
            rows={2}
            className="font-mono text-xs"
            defaultValue={values.postLogoutRedirectUris}
            aria-describedby={
              errors.postLogoutRedirectUris
                ? field("postLogoutRedirectUris-error")
                : field("post-logout-help")
            }
            aria-invalid={errors.postLogoutRedirectUris ? true : undefined}
          />
          <FieldDescription id={field("post-logout-help")}>
            {t.admin.clients.onePerLine}
          </FieldDescription>
          <FieldError id={field("postLogoutRedirectUris-error")}>
            {uriMessage(t, errors.postLogoutRedirectUris)}
          </FieldError>
        </Field>
      </AdminCard>

      <AdminCard
        title={t.admin.clients.groupPermissions}
        description={t.admin.clients.groupPermissionsHelp}
        className="gap-4"
      >
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
                defaultChecked={values.scopes.includes(scope)}
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
            defaultChecked={values.requireConsent}
            aria-label={t.admin.clients.requireConsentLabel}
            aria-describedby={field("require-consent-help")}
          />
          <span>
            {t.admin.clients.requireConsentLabel}
            <span
              id={field("require-consent-help")}
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
            defaultChecked={values.enableEndSession}
            aria-label={t.admin.clients.enableEndSession}
            aria-describedby={field("end-session-help")}
          />
          <span>
            {t.admin.clients.enableEndSession}
            <span
              id={field("end-session-help")}
              className="block text-xs text-muted-foreground"
            >
              {t.admin.clients.enableEndSessionHelp}
            </span>
          </span>
        </Label>
      </AdminCard>
    </>
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
export function useClientForm(): {
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
 * `invalid` and `reserved` are different refusals (**D93**).
 *
 * "Use letters, digits and `. _ ~ -`" is exactly what `.` and `..` already
 * are, so the generic message would be a refusal describing the value as
 * acceptable — which is how a reader concludes the form is broken.
 */
function clientIdMessage(t: Catalog, code: string | undefined) {
  if (!code) return undefined
  return code === "reserved"
    ? t.admin.clients.reservedClientId
    : t.admin.clients.invalidClientId
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
