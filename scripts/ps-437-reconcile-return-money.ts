/**
 * PS-437 bounded historical return-money reconciliation.
 *
 * Dry-run is the default and always rolls back. Apply requires all three flags:
 *   --apply --confirm-production --expected-count=2
 *
 * The two candidates are fixed because this is an evidence-specific repair,
 * not a generic legacy fallback. The script never calls a carrier, buys a
 * label, changes order/shipment status, or rewrites billing records.
 */
import 'dotenv/config';
import postgres from 'postgres';
import {
  previewShipmentCustomerShippingMoneyWithSelectedRateCost,
  readFrozenCustomerShippingMoney,
  type FrozenCustomerShippingMoney,
} from '../src/services/customer-shipping-money.js';

type Candidate = {
  returnId: number;
  returnReference: string;
  shipmentId: number;
  selectedRateCost: number;
  expectedCustomerRate: number;
};

type GuardRow = {
  return_id: number;
  return_reference: string | null;
  return_status: string;
  return_customer_shipping_rate: string | number | null;
  order_id: number | null;
  shipment_id: number;
  shipment_source: string | null;
  is_return: boolean;
  voided: boolean;
  selected_rate_cost: string | number | null;
  selected_rate_json: unknown;
  cost: string | number | null;
  label_cost: string | number | null;
  other_cost: string | number | null;
  label_created_at: Date | string | null;
  has_label_provider_key: boolean;
  client_name: string | null;
};

type CountRow = { count: number | string };
type UpdatedRow = { id: number; selected_rate_json?: unknown };

type PreparedCandidate = Candidate & {
  snapshot: FrozenCustomerShippingMoney;
};

class DryRunRollback extends Error {}

const candidates: Candidate[] = [
  {
    returnId: 4,
    returnReference: '2659-RETURN',
    shipmentId: 28887,
    selectedRateCost: 5.58,
    expectedCustomerRate: 6.77,
  },
  {
    returnId: 6,
    returnReference: '2142-RETURN',
    shipmentId: 28889,
    selectedRateCost: 5.70,
    expectedCustomerRate: 6.77,
  },
];

function number(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyEqual(left: unknown, right: number): boolean {
  const parsed = number(left);
  return parsed != null && Math.abs(parsed - right) < 0.001;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function envelopeShippingAmount(value: unknown): number | null {
  const row = record(value);
  const shipping = record(row?.shipping_amount);
  return number(shipping?.amount);
}

function expectedCountFromArgs(args: string[]): number | null {
  const raw = args.find((arg) => arg.startsWith('--expected-count='))?.split('=', 2)[1];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmProduction = args.includes('--confirm-production');
const expectedCount = expectedCountFromArgs(args);
if (apply && (!confirmProduction || expectedCount !== candidates.length)) {
  throw new Error(
    `Apply requires --confirm-production --expected-count=${candidates.length}`,
  );
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const prepared: PreparedCandidate[] = [];
for (const candidate of candidates) {
  const decision = await previewShipmentCustomerShippingMoneyWithSelectedRateCost(
    candidate.shipmentId,
    candidate.selectedRateCost,
  );
  if (!moneyEqual(decision.cShippingRateAmount, candidate.expectedCustomerRate)) {
    throw new Error(
      `Canonical customer amount changed for shipment ${candidate.shipmentId}; refusing repair`,
    );
  }
  prepared.push({
    ...candidate,
    snapshot: {
      selectedRateCost: decision.selectedRateCost,
      cShippingRateAmount: decision.cShippingRateAmount,
      shippingMarginAmount: decision.shippingMarginAmount,
      shippingMarginPct: decision.shippingMarginPct,
      customerRateSource: decision.customerRateSource,
      rateCostSource: decision.rateCostSource,
      customerShippingMoneyPolicyVersion: decision.customerShippingMoneyPolicyVersion,
    },
  });
}

const sql = postgres(databaseUrl, { max: 1, prepare: false, max_pipeline: 1 });
const summary: Array<Record<string, unknown>> = [];

try {
  await sql.begin(async (tx) => {
    for (const candidate of prepared) {
      const [row] = await tx<GuardRow[]>`
        select
          r.id as return_id,
          r.return_reference,
          r.status as return_status,
          r.return_customer_shipping_rate,
          r.order_id,
          s.id as shipment_id,
          s.source as shipment_source,
          coalesce(s.is_return, false) as is_return,
          coalesce(s.voided, false) as voided,
          s.selected_rate_cost,
          s.selected_rate_json,
          s.cost,
          s.label_cost,
          s.other_cost,
          s.label_created_at,
          (s.label_provider_key is not null) as has_label_provider_key,
          c.name as client_name
        from returns r
        join shipments s on s.id = r.return_shipment_id
        left join orders o on o.id = r.order_id
        left join clients c on c.id = coalesce(s.client_id, r.client_id, o.client_id)
        where r.id = ${candidate.returnId}
          and s.id = ${candidate.shipmentId}
        for update of r, s
      `;
      if (!row) throw new Error(`Candidate shipment ${candidate.shipmentId} disappeared`);

      const existingSnapshot = readFrozenCustomerShippingMoney(row.selected_rate_json);
      const exactGuard =
        row.return_reference === candidate.returnReference &&
        row.return_status === 'label_created' &&
        row.shipment_source === 'prepship_return_v2' &&
        row.is_return &&
        !row.voided &&
        row.selected_rate_cost == null &&
        existingSnapshot == null &&
        row.label_created_at != null &&
        row.has_label_provider_key &&
        row.client_name?.toUpperCase() === 'HUGRAB' &&
        moneyEqual(row.return_customer_shipping_rate, candidate.selectedRateCost) &&
        moneyEqual(row.cost, candidate.selectedRateCost) &&
        moneyEqual(row.label_cost, candidate.selectedRateCost) &&
        (number(row.other_cost) ?? 0) === 0 &&
        moneyEqual(envelopeShippingAmount(row.selected_rate_json), candidate.selectedRateCost);
      if (!exactGuard) {
        throw new Error(
          `Exact persisted-provider-receipt guard failed for shipment ${candidate.shipmentId}`,
        );
      }

      const [billing] = await tx<CountRow[]>`
        select count(*)::integer as count
        from billing_line_items
        where shipment_id = ${candidate.shipmentId}
          or (
            order_id = ${row.order_id}
            and line_type in ('return_postage', 'return_processing_fee')
          )
      `;
      if (Number(billing?.count ?? 0) !== 0) {
        throw new Error(
          `Billing already exists for shipment ${candidate.shipmentId}; refusing history rewrite`,
        );
      }

      // Per user override unlock shipped data on 2026-05-23: PS-437 repairs
      // only two exact provider-backed return snapshots and their compatibility
      // aliases; label, status, billing, postage, and marketplace facts are untouched.
      const updatedShipments = await tx<UpdatedRow[]>`
        update shipments
        set selected_rate_cost = ${candidate.selectedRateCost.toFixed(2)},
          selected_rate_json = coalesce(selected_rate_json, '{}'::jsonb)
            || ${tx.json(candidate.snapshot)}::jsonb,
          updated_at = now()
        where id = ${candidate.shipmentId}
          and selected_rate_cost is null
          and coalesce(is_return, false) = true
          and coalesce(voided, false) = false
          and not (
            coalesce(selected_rate_json, '{}'::jsonb)
              ? 'customerShippingMoneyPolicyVersion'
          )
        returning id, selected_rate_json
      `;
      const updatedReturns = await tx<UpdatedRow[]>`
        update returns
        set return_customer_shipping_rate = ${candidate.expectedCustomerRate.toFixed(2)},
          updated_at = now()
        where id = ${candidate.returnId}
          and return_shipment_id = ${candidate.shipmentId}
          and return_customer_shipping_rate = ${candidate.selectedRateCost.toFixed(2)}
        returning id
      `;
      const frozen = readFrozenCustomerShippingMoney(updatedShipments[0]?.selected_rate_json);
      if (
        updatedShipments.length !== 1 ||
        updatedReturns.length !== 1 ||
        !frozen ||
        !moneyEqual(frozen.cShippingRateAmount, candidate.expectedCustomerRate)
      ) {
        throw new Error(`Atomic repair verification failed for shipment ${candidate.shipmentId}`);
      }
      summary.push({
        returnId: candidate.returnId,
        returnReference: candidate.returnReference,
        shipmentId: candidate.shipmentId,
        selectedRateCost: candidate.selectedRateCost,
        cShippingRateAmount: frozen.cShippingRateAmount,
        shippingMarginAmount: frozen.shippingMarginAmount,
        shippingMarginPct: frozen.shippingMarginPct,
        policyVersion: frozen.customerShippingMoneyPolicyVersion,
      });
    }

    if (summary.length !== candidates.length) {
      throw new Error('Not every expected candidate was repaired; transaction rolled back');
    }
    if (!apply) throw new DryRunRollback('Dry-run rollback');
  });
} catch (error) {
  if (!(error instanceof DryRunRollback)) throw error;
} finally {
  await sql.end();
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run-rolled-back',
  updatedCount: summary.length,
  rows: summary,
}, null, 2));
