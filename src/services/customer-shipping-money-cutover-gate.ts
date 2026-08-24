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

/**
 * PS-508 W6 — the cutover boundary.
 *
 * Before the boundary, a shipment with no frozen tuple is a legitimate historical row and the
 * legacy recalculation is the correct answer. At or after it, freezing is live, so a missing
 * tuple is a FAILURE, not a legacy row, and must be held rather than silently repriced from
 * today's config.
 *
 * `invalid` is deliberately distinct from `none`. If a typo in the boundary collapsed to "no
 * boundary", a single bad character in an env var would silently switch the protection off and
 * every post-cutover freeze failure would start billing a recomputed number again. Callers must
 * treat `invalid` as fail-closed.
 */
export type CutoverBoundary =
  | { kind: 'none' }
  | { kind: 'at'; at: Date }
  | { kind: 'invalid'; raw: string };

export function resolveCutoverBoundary(rawBoundary: string | null | undefined): CutoverBoundary {
  const value = (rawBoundary ?? '').trim();
  if (value === '') return { kind: 'none' };
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return { kind: 'invalid', raw: value };
  return { kind: 'at', at };
}

/**
 * Is this shipment governed by the post-cutover "tuple required" rule?
 *
 * An undated shipment counts as post-cutover once a boundary is configured. It cannot be PROVEN
 * pre-cutover, and on a money path an unprovable row is held, not billed from a recomputed
 * number. Real post-cutover shipments always carry a ship date; undated rows are characteristic
 * of old or incomplete records, so the canary client surfaces the true volume before expansion.
 */
export function isAfterCutover(boundary: CutoverBoundary, shipDate: Date | null | undefined): boolean {
  if (boundary.kind === 'none') return false;
  if (boundary.kind === 'invalid') return true;
  if (shipDate == null) return true;
  const t = shipDate instanceof Date ? shipDate.getTime() : new Date(shipDate).getTime();
  if (Number.isNaN(t)) return true;
  return t >= boundary.at.getTime();
}
