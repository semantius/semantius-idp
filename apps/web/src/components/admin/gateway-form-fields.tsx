import { useCallback, useId, useState } from "react"
import type { ComponentProps } from "react"

import { Checkbox } from "@workspace/ui/components/checkbox"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field"

import { FieldError } from "@/components/auth/form-parts"
import { GATEWAY_NAME_PATTERN, validateGatewayForm } from "@/lib/gateway-rules"
import type { GatewayFormErrors } from "@/lib/gateway-rules"
import type { Draft } from "@/server/http/draft"
import type { Catalog } from "@/server/i18n"

/**
 * The four fields a gateway is described by, shared by the create and edit
 * dialogs (FR-GW-7, **D91**, **D92**).
 *
 * Shared for the reason `client-form-fields.tsx` sets out at length:
 * `/idp/update-gateway` is a **full replace**, so a field the edit form does
 * not render is a field every edit silently resets. One markup, two dialogs,
 * and that failure mode becomes impossible rather than merely unlikely.
 *
 * **Every id is generated** (`useId`). `name` is unique in a form and
 * emphatically not in a document, and an edit dialog is rendered once per row
 * — a hard-coded `id="name"` would put one id on as many controls as there are
 * gateways, and every `<label for>` on the page would resolve to the first.
 */
export interface GatewayFormValues {
  name: string
  url: string
  requireAuth: boolean
  trustProxy: boolean
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
export function resolveGatewayFormValues(
  draft: Draft | undefined,
  fallback: GatewayFormValues
): GatewayFormValues {
  const values: Draft = draft ?? {}
  if (Object.keys(values).length === 0) return fallback

  return {
    name: values.name ?? fallback.name,
    url: values.url ?? fallback.url,
    requireAuth: values.requireAuth === "on",
    trustProxy: values.trustProxy === "on",
  }
}

export function GatewayFormFields({
  t,
  values,
  errors,
  fixedName = false,
}: {
  t: Catalog
  values: GatewayFormValues
  errors: GatewayFormErrors
  /**
   * The edit dialog. The name is the URL segment callers have configured, so
   * it is shown and not editable — as text plus a hidden input, because a
   * `disabled` input contributes no name/value pair and the handler would not
   * know which gateway it was told to change.
   */
  fixedName?: boolean
}) {
  const id = useId()
  const field = (name: string) => `${id}-${name}`

  return (
    <>
      <Field>
        <FieldLabel htmlFor={field("name")}>
          {t.admin.gateways.name}
        </FieldLabel>
        {fixedName ? (
          <>
            <input type="hidden" name="name" value={values.name} />
            <code
              id={field("name")}
              className="block rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all"
            >
              {values.name}
            </code>
            <FieldDescription>{t.admin.gateways.nameFixed}</FieldDescription>
          </>
        ) : (
          <>
            <Input
              id={field("name")}
              name="name"
              required
              autoComplete="off"
              pattern={GATEWAY_NAME_PATTERN}
              defaultValue={values.name}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={
                errors.name ? field("name-error") : field("name-help")
              }
            />
            <FieldDescription id={field("name-help")}>
              {t.admin.gateways.addHelp}
            </FieldDescription>
            <FieldError id={field("name-error")}>
              {errors.name ? t.admin.gateways.invalidName : undefined}
            </FieldError>
          </>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor={field("url")}>{t.admin.gateways.url}</FieldLabel>
        <Input
          id={field("url")}
          name="url"
          required
          autoComplete="off"
          inputMode="url"
          className="font-mono text-xs"
          defaultValue={values.url}
          aria-invalid={errors.url ? true : undefined}
          aria-describedby={
            errors.url ? field("url-error") : field("url-help")
          }
        />
        <FieldDescription id={field("url-help")}>
          {t.admin.gateways.urlHelp}
        </FieldDescription>
        <FieldError id={field("url-error")}>
          {urlMessage(t, errors.url)}
        </FieldError>
      </Field>
      {/* `aria-describedby`, not just visible text: the control is a
          `role="checkbox"` span, so neither the wrapping label nor the help
          underneath it reaches a screen reader on its own. */}
      <Label className="flex items-start gap-2 text-sm font-normal">
        <Checkbox
          name="requireAuth"
          value="on"
          defaultChecked={values.requireAuth}
          aria-label={t.admin.gateways.requireAuth}
          aria-describedby={field("require-auth-help")}
        />
        <span>
          {t.admin.gateways.requireAuth}
          <span
            id={field("require-auth-help")}
            className="block text-xs text-muted-foreground"
          >
            {t.admin.gateways.requireAuthHelp}
          </span>
        </span>
      </Label>
      <Label className="flex items-start gap-2 text-sm font-normal">
        <Checkbox
          name="trustProxy"
          value="on"
          defaultChecked={values.trustProxy}
          aria-label={t.admin.gateways.trustProxy}
          aria-describedby={field("trust-proxy-help")}
        />
        <span>
          {t.admin.gateways.trustProxy}
          <span
            id={field("trust-proxy-help")}
            className="block text-xs text-muted-foreground"
          >
            {t.admin.gateways.trustProxyHelp}
          </span>
        </span>
      </Label>
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
export function useGatewayForm(): {
  onSubmit: (event: FormSubmitEvent) => void
  errors: GatewayFormErrors
} {
  const [errors, setErrors] = useState<GatewayFormErrors>({})

  const onSubmit = useCallback((event: FormSubmitEvent) => {
    const form = event.currentTarget
    const read = (name: string): string => {
      const field = form.elements.namedItem(name)
      return field instanceof HTMLInputElement ? field.value : ""
    }

    const found = validateGatewayForm({
      name: read("name"),
      url: read("url"),
    })

    setErrors(found)
    if (Object.keys(found).length === 0) return

    event.preventDefault()
    // Focus the first field with a problem, or the message is announced with
    // no way to reach what it is about.
    for (const name of ["name", "url"] as const) {
      if (!found[name]) continue
      const field = form.elements.namedItem(name)
      if (field instanceof HTMLElement) field.focus()
      return
    }
  }, [])

  return { onSubmit, errors }
}

/**
 * Turns a `url:<problem>:<value>` code into a catalog sentence.
 *
 * The offending URL is carried in the code rather than in the message, because
 * wording never leaves the catalog (FR-I18N-1).
 */
function urlMessage(t: Catalog, code: string | undefined): string | undefined {
  if (!code) return undefined
  if (code === "required") return t.admin.gateways.urlRequired
  const [, problem = "", ...rest] = code.split(":")
  const url = rest.join(":")
  switch (problem) {
    case "not_absolute":
      return t.admin.gateways.urlNotAbsolute(url)
    case "scheme":
      return t.admin.gateways.urlScheme(url)
    case "trailing_slash":
      return t.admin.gateways.urlTrailingSlash(url)
    case "query":
      return t.admin.gateways.urlQuery(url)
    case "fragment":
      return t.admin.gateways.urlFragment(url)
    case "credentials":
      return t.admin.gateways.urlCredentials(url)
    default:
      return undefined
  }
}
