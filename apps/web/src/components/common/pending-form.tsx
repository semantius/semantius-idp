import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import type { ComponentProps } from "react"

import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"
import { cn } from "@workspace/ui/lib/utils"

/**
 * "Something is happening" for ordinary `method="post"` forms.
 *
 * Every mutation in this application is a real form post followed by a 303, so
 * there is no client-side mutation state to read: between the click and the
 * new document the page simply sits there. On a cold container that is long
 * enough to look broken, and long enough for a second click to post the form
 * twice.
 *
 * Three mechanics are load-bearing and each of them was arrived at the hard
 * way:
 *
 * 1. **The double-submit guard is a ref, not state.** It has to take effect
 *    synchronously, inside the same submit handler; a `setState` would not be
 *    visible until the next render, by which time the second submission has
 *    already gone.
 *
 * 2. **The visual state is deferred by one frame.** The browser builds the
 *    form entry list *after* the submit handler returns, and a submitter
 *    carrying a native `disabled` attribute by then contributes no name/value
 *    pair — which would turn `/consent`'s approval, posted as `decision=allow`
 *    from the button itself, into a request with no decision in it.
 *
 *    As written, `SubmitButton` cannot hit that: `focusableWhenDisabled` makes
 *    Base UI emit `aria-disabled` and *not* the native attribute. The frame is
 *    kept anyway, because the day someone drops `focusableWhenDisabled` — the
 *    obvious simplification — is the day consent silently starts posting
 *    nothing, and nothing else here would catch it.
 *
 * 3. **Pending state is cleared on `pageshow` with `persisted`.** Going back
 *    to a posted form through the back/forward cache restores the DOM as it
 *    was — spinner still spinning, controls still disabled — on a page that is
 *    not submitting anything.
 *
 * Before hydration the form still posts natively; it just does so without the
 * spinner. That is the documented degraded case (D31), not a bug.
 */

/** Whatever React's own `<form onSubmit>` is typed as, in this React. */
type FormSubmitEvent = Parameters<
  NonNullable<ComponentProps<"form">["onSubmit"]>
>[0]

interface PendingState {
  pending: boolean
  /**
   * `data-submit-id` of the control that started it, so only that one grows a
   * spinner. An id rather than the DOM node itself: comparing nodes would mean
   * reading a ref during render, and this way `SubmitButton` decides whether
   * it is the submitter from its own props and `useId` alone.
   */
  submitterId: string | null
}

const PendingContext = createContext<PendingState>({
  pending: false,
  submitterId: null,
})

export function usePendingForm(): PendingState {
  return useContext(PendingContext)
}

export function PendingForm({
  children,
  busy,
  onSubmit,
  className,
  ...props
}: ComponentProps<"form"> & {
  /**
   * What a screen reader hears while the form is in flight — the catalog's
   * `common.loading`. Required, because a silent busy state is the one this
   * component exists to stop.
   */
  busy: string
}) {
  const [state, setState] = useState<PendingState>({
    pending: false,
    submitterId: null,
  })
  // Synchronous. See mechanic 1 above.
  const inFlight = useRef(false)

  useEffect(() => {
    function reset(event: PageTransitionEvent) {
      if (!event.persisted) return
      inFlight.current = false
      setState({ pending: false, submitterId: null })
    }
    window.addEventListener("pageshow", reset)
    return () => {
      window.removeEventListener("pageshow", reset)
    }
  }, [])

  const handleSubmit = useCallback(
    (event: FormSubmitEvent) => {
      onSubmit?.(event)
      if (event.defaultPrevented) return
      if (inFlight.current) {
        event.preventDefault()
        return
      }
      inFlight.current = true
      // React 19 types `nativeEvent` as a real `SubmitEvent`, so this is the
      // pressed control itself and not a guess from `document.activeElement`.
      const submitterId = event.nativeEvent.submitter?.dataset.submitId ?? null
      // Mechanic 2: after the entry list is built, never before.
      requestAnimationFrame(() => {
        setState({ pending: true, submitterId })
      })
    },
    [onSubmit]
  )

  return (
    <PendingContext.Provider value={state}>
      <form
        {...props}
        onSubmit={handleSubmit}
        aria-busy={state.pending || undefined}
        data-pending={state.pending ? "" : undefined}
        className={className}
      >
        {children}
        {/* Outside the visual flow, inside the form, so it is announced in the
            context of the thing that is busy. Rendered always and filled
            conditionally: a live region has to exist before it changes. */}
        <span role="status" aria-live="polite" className="sr-only">
          {state.pending ? busy : ""}
        </span>
      </form>
    </PendingContext.Provider>
  )
}

/**
 * The button that submits a `PendingForm`.
 *
 * Outside one it is an ordinary kit `Button` with `type="submit"`, so it is
 * safe to use everywhere and there is no second component to remember.
 *
 * While the form is in flight the spinner goes on the control that was
 * actually pressed — a form with three buttons must not sprout three
 * spinners — and it is `aria-hidden`, so the accessible name stays exactly
 * what it was. Playwright's `getByRole("button", { name })` and every axe
 * check depend on that not moving.
 *
 * Disabling is deliberately two different things:
 *
 * - **In flight**, `focusableWhenDisabled` keeps the control in the tab order
 *   while suppressing activation, so focus is not thrown to the top of the
 *   document at the exact moment the page is about to be replaced.
 * - **A caller's own `disabled`** — "you cannot suspend yourself" — stays a
 *   native `disabled` attribute, because that is a permanent property of the
 *   control rather than a transient one, and it is what assistive technology
 *   and `toBeDisabled()` both expect.
 */
export function SubmitButton({
  children,
  className,
  disabled,
  ...props
}: ComponentProps<typeof Button>) {
  const { pending, submitterId } = usePendingForm()
  const id = useId()
  const isSubmitter = pending && submitterId === id

  return (
    <Button
      type="submit"
      data-submit-id={id}
      // A caller's `disabled` wins and stays native; pending is the softer one.
      {...(disabled
        ? { disabled: true }
        : pending
          ? { disabled: true, focusableWhenDisabled: true }
          : {})}
      className={cn(
        !disabled && pending && "data-[disabled]:opacity-60",
        className
      )}
      {...props}
    >
      {isSubmitter ? (
        <Spinner data-icon="inline-start" aria-hidden="true" />
      ) : null}
      {children}
    </Button>
  )
}
