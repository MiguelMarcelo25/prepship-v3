// PS-472: turn an opaque automation failure into a sentence an operator can act on.
//
// 2026-07-30. A hazmat rule matched HU-10 HUGRAB orders and tried to write a
// declaration. The write was refused ("Hazmat declaration writes are disabled.")
// because a capability flag was off on the service running the automation. One
// failed action fails the whole run, and a failed run blocks rating -- so the
// operator saw only "Rate unavailable · Retry" on the row and
// "Automation evaluation failed; retry or review before continuing" in the API
// response. Neither names hazmat, the action, or the flag.
//
// 11 orders were frozen for two days and it took database forensics across
// automation_runs -> automation_action_results to find the one-line cause.
// The information existed the whole time; nothing carried it to the operator.
//
// Pure string building on purpose -- no DB, no env -- so the guard can call it
// directly rather than pattern-matching source.

const CLOSER = 'Resolve it before rating or label purchase.';

/**
 * Build the operator-facing explanation for a blocked order.
 *
 * `reason` is the raw handler message (e.g. "Hazmat declaration writes are
 * disabled."). Trailing punctuation is normalised so the composed sentence does
 * not end up with ".." when a handler already punctuated its message.
 */
export function automationFailureMessage(input: {
  actionType?: string | null;
  reason?: string | null;
}): string {
  const actionType = (input.actionType ?? '').trim();
  const reason = (input.reason ?? '').trim().replace(/[.\s]+$/, '');

  if (actionType && reason) {
    return `Automation could not apply ${actionType}: ${reason}. ${CLOSER}`;
  }
  if (reason) {
    return `Automation failed: ${reason}. ${CLOSER}`;
  }
  if (actionType) {
    return `Automation could not apply ${actionType}. ${CLOSER}`;
  }
  // Last resort only: no effect row was recorded for the failure.
  return `Automation evaluation failed. ${CLOSER}`;
}
