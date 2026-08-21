import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billingConfigHasHouseAccountEnabledColumn } from './billing-column-presence.js';
import { normalizeOrderBestRateDto } from './order-rate-dto.js';
import { planRealizedHouseCapture } from './shipping-workflow/house-margin-derivation.js';

/**
 * PS-508 — the house customer rate, DERIVED in-transaction rather than read from the sidecar.
 *
 * ── WHY THIS CANNOT READ order_competitive_rate ─────────────────────────────────────────
 *
 * Billing's house path bills `order_competitive_rate.customer_rate` (billing.ts loads it for house
 * orders and passes it as `cShippingRateAmount`). The obvious way to make an outbound freeze agree
 * with billing would be to read that same row. It does not exist yet.
 *
 * `captureRealizedHouseMargin` is the sole writer of that row, and labels.ts fires it through
 * `timer.background(...)` AFTER the ship transaction commits — fire-and-forget, failures only
 * console.warn'd, and only when `directProviderKey === 'shipp'`. It also keys on `shipment_id`,
 * which does not exist until the shipment INSERT returns. A freeze inside the label transaction
 * therefore cannot read it, and a freeze after the transaction would race a write that is allowed
 * to fail silently.
 *
 * So this recomputes the number from the SAME INPUTS the capture uses — the projected next-best
 * stamp in `order_overrides.best_rate_json` and the client's house opt-in — through the SAME pure
 * gate (`planRealizedHouseCapture`). Two derivations of one number is a drift risk, which is
 * exactly why both go through that one shared owner rather than each doing the arithmetic.
 *
 * The alternative was to make the background capture load-bearing and sequence the freeze behind
 * it. That would turn a deliberately best-effort path into one that can fail a label purchase.
 *
 * ── THE COST BASIS IS NOT created.cost ──────────────────────────────────────────────────
 *
 * The sidecar stores `drp_cost = created.cost` (postage only), but billing floors the house amount
 * at `resolveBillingSelectedRateCost`, which prefers the persisted `selected_rate_cost` column —
 * postage PLUS insurance. Callers must therefore pass the same selected cost the tuple is being
 * frozen against, not the bare postage, or the frozen number will not reproduce the invoice on any
 * shipment carrying insurance.
 *
 * Note this only moves the result when there is no competitor stamp (the pass-through case, where
 * customerRate falls back to drpCost). With a competitor, `customerRate` is the competitor's
 * totalCost and is independent of the basis — the floor in decideShippingLineBilling does the rest.
 */
export async function deriveOutboundHouseCustomerRate(input: {
  orderId: number | null;
  clientId: number | null;
  /** The SAME selected cost being frozen (postage + insurance), never bare postage. */
  selectedRateCost: number;
  exec?: Pick<typeof db, 'execute'>;
}): Promise<number | null> {
  if (input.orderId == null || input.clientId == null) return null;
  if (!Number.isFinite(input.selectedRateCost) || input.selectedRateCost <= 0) return null;

  const exec = input.exec ?? db;
  // DEFAULT-OFF on a database that lacks the column. `house_account_enabled` IS owned by numbered
  // migration 0050 (drizzle/0050_billing_config_house_account.sql) — an earlier comment here
  // claimed it was runtime-ensured only, which was wrong. It is additionally ensured at runtime by
  // `ensureHouseAccountColumn()`, and calling that helper
  // here would mean DDL under the ship lock. A client cannot be opted in to a column that does not
  // exist, so answering "not opted in" cannot under-bill anyone who genuinely was.
  if (!(await billingConfigHasHouseAccountEnabledColumn(exec))) return null;

  const result = await exec.execute(sql`
    select
      (select coalesce(house_account_enabled, false)
         from billing_config where client_id = ${input.clientId} limit 1) as "houseAccountEnabled",
      (select best_rate_json
         from order_overrides where order_id = ${input.orderId} limit 1) as "bestRateJson"
  `);
  // Shape-tolerant: drizzle over postgres-js returns a bare array, over PGlite `{ rows }`.
  const rows = (Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
      houseAccountEnabled?: boolean | null;
      bestRateJson?: unknown;
    }>;
  const row = rows[0];
  if (!row) return null;

  const optedIn = row.houseAccountEnabled === true;
  const realized = planRealizedHouseCapture({
    drpCost: input.selectedRateCost,
    optedIn,
    shippingMarginPolicy: { mode: optedIn ? 'next_best_customer_rate' : 'pass_through' },
    best: normalizeOrderBestRateDto(row.bestRateJson ?? null),
  });
  return realized?.customerRate ?? null;
}
