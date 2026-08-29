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
 * `readFormMulti` — and the list reaches `/admin/set-role` through
 * `runAdminAction`, which is where the reassembly lives since **D93**. It used
 * to be three lines in the route, and a second route naming the reader without
 * them would have stored one role of two under a success toast.
 */
export function RoleCheckboxes({
  roles,
  legend,
  checked,
  disabled = false,
}: {
  roles: { name: string }[]
  legend: string
  /** Role names to tick. Absent on a creation, where nothing is held yet. */
  checked?: readonly string[]
  /**
   * Your own account (**D93**, FR-ADMIN-3).
   *
   * **On each `Checkbox`, not only on the `<fieldset>`.** A disabled fieldset
   * disables the *form controls* inside it, and the control a user operates
   * here is a `<span role="checkbox">` with a hidden input behind it — so the
   * fieldset alone left the span enabled, focusable and announced as
   * available, while silently dropping the value from the submission. The
   * fieldset is disabled as well, because that is what actually guarantees
   * nothing is submitted.
   */
  disabled?: boolean
}) {
  const held = new Set(checked ?? [])

  return (
    <fieldset disabled={disabled} className="grid gap-2">
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
            disabled={disabled}
          />
          {role.name}
        </Label>
      ))}
    </fieldset>
  )
}
