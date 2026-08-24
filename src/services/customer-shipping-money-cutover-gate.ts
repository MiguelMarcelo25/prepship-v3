/**
 * PS-508 W5 — the per-client activation gate for the Billing cutover.
 *
 * TOPOLOGY RULING (2026-08-24, formalised after the Hermes re-audit, correction 4): this is a
 * DARK-WRITE / GATED-READ architecture, deliberately — not the card's original "one gate covers
 * writing and consumption" wording, which is hereby revised.
 *
 *   - The WRITER is unconditional. labels.ts freezes the outbound tuple on every controlled
 *     purchase, gate or no gate. Tuples must accumulate on every shipment BEFORE the canary,
 *     or there is nothing to shadow-compare when the gate is first enabled; gating the writer
 *     would starve the canary of exactly the evidence it needs. Freeze failure never fails a
 *     paid-for label.
 *   - BILLING consumption is gated here, per client, default off.
 *   - The PORTAL displays accepted tuples ungated; it is a display of label-time truth, not a
 *     billing decision. Portal-vs-Billing contract parity (the suffix rule) is enforced by the
 *     tuple validity requirements, not by this gate.
 *
 * The invariant the original wording protected still holds, one-directionally: Billing can never
 * consume for a client the writer is not freezing (the writer freezes for everyone). The reverse
 * — writing without consuming — is the intended dark-write state.
 *
 * Default EMPTY means OFF for every client, and OFF must be byte-identical to pre-cutover
 * behaviour — callers bypass the frozen-tuple decision entirely rather than passing an empty
 * accepted-version list, which would route valid tuples to review instead of leaving them on the
 * legacy path.
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
