import { Checkbox } from "@workspace/ui/components/checkbox"
import { Label } from "@workspace/ui/components/label"

/**
 * One checkbox per catalog role (item 11b, FR-ROLE-2).
 *
 * Both places that assign roles — creating a user, and editing one — used a
 * comma-separated text field, which asked the administrator to know the catalog
 * by heart and spell it correctly. A typo produced a role nobody holds, which
 * the FR-ROLE-2 check then reported as a warning at the next boot. The catalog
 * is already on the page, so it may as well be the control.
 *
 * The field name repeats, once per ticked box, so the handler reads it with
 * `readFormMulti` and joins — `set-roles` has always taken a comma string and
 * its dispatcher is unchanged.
 */
export function RoleCheckboxes({
  roles,
  legend,
  checked,
}: {
  roles: { name: string }[]
  legend: string
  /** Role names to tick. Absent on a creation, where nothing is held yet. */
  checked?: readonly string[]
}) {
  const held = new Set(checked ?? [])

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {roles.map((role) => (
        <Label
          key={role.name}
          className="group/field-label flex items-center gap-2 text-sm font-normal"
        >
          {/* `aria-label` as well as the wrapping label: Base UI renders the
              control as a `<span role="checkbox">` beside an aria-hidden
              input, and a wrapping `<label>` names a *form control* — which
              the span is not. Without this the checkbox has no accessible
              name, which fails axe and is invisible to a screen reader. */}
          <Checkbox
            name="roles"
            value={role.name}
            aria-label={role.name}
            defaultChecked={held.has(role.name)}
          />
          {role.name}
        </Label>
      ))}
    </fieldset>
  )
}
