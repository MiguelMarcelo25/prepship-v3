/**
 * PS-508 W5 — the per-client activation gate for the Billing cutover.
 *
 * ONE gate covers both ordinary snapshot writing and Billing's frozen-tuple consumption; the
 * card forbids enabling either without the other. Default EMPTY means OFF for every client, and
 * OFF must be byte-identical to pre-cutover behaviour — callers bypass the frozen-tuple decision
 * entirely rather than passing an empty accepted-version list, which would route valid tuples to
 * review instead of leaving them on the legacy path.
 *
 * Pure by design: the allowlist arrives as a string so this is testable with no env and no DB,
 * and so the gate cannot quietly read different state than the caller believes it read.
 */
export function isFrozenTupleBillingEnabledForClient(input: {
  clientId: number | null | undefined;
  /** Raw allowlist, e.g. `env.PS508_BILLING_FROZEN_TUPLE_CLIENTS`. */
  allowlist: string;
}): boolean {
  const list = (input.allowlist ?? '').trim();
  if (list === '') return false;
  if (list === '*') return true;
  if (input.clientId == null) return false;
  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .includes(String(input.clientId));
}
