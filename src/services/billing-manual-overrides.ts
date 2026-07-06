/**
 * PS-392 - durable manual Billing overrides.
 *
 * Manual Billing edits are operator decisions, not generated-row tweaks. This
 * store records the customer-billed amount the operator chose, and the billing
 * generator applies those decisions before freezing billing_line_items. Shipping
 * overrides here are customer-billed C. Shipping values only; shipment selected
 * rate, label cost, and paid postage fields are never mutated.
 */
import { sql as drizzleSql, type SQL } from 'drizzle-orm';
import { db, sql as pg } from '../db/client';

export const MANUAL_BILLING_OVERRIDE_LINE_TYPES = [
  'pick_pack',
  'additional_unit',
  'shipping',
] as const;

export type ManualBillingOverrideLineType =
  (typeof MANUAL_BILLING_OVERRIDE_LINE_TYPES)[number];

const MANUAL_BILLING_OVERRIDE_TYPE_SET = new Set<string>(
  MANUAL_BILLING_OVERRIDE_LINE_TYPES,
);

export type BillingManualOverrideRow = {
  orderId: number;
  clientId: number;
  lineType: ManualBillingOverrideLineType;
  amount: number;
  reviewer: string | null;
  reviewedAt: string | null;
  note: string | null;
};

export type BillingManualOverrideUpsert = {
  orderId: number;
  clientId: number;
  lineType: ManualBillingOverrideLineType;
  amount: number;
  reviewer: string | null;
  note: string | null;
};

export type BillingManualOverrideExecutor = {
  execute: (query: SQL) => Promise<unknown>;
};

export type ManualBillingLine = {
  clientId: number;
  orderId: number | null;
  orderNumber: string | null;
  shipmentId: number | null;
  shipDate: Date | null;
  lineType: string;
  description: string;
  qty: string;
  unitCost: string;
  totalCost: string;
  packageId: number | null;
};

export type ManualBillingLineBase = Omit<
  ManualBillingLine,
  'lineType' | 'description' | 'qty' | 'unitCost' | 'totalCost'
>;

let schemaEnsured: Promise<void> | null = null;

export async function ensureBillingManualOverridesSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS billing_manual_overrides (
        order_id integer NOT NULL,
        client_id integer NOT NULL,
        line_type text NOT NULL,
        amount numeric(10, 2) NOT NULL,
        reviewer text,
        reviewed_at timestamptz NOT NULL DEFAULT now(),
        note text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT billing_manual_overrides_line_type_chk
          CHECK (line_type IN ('pick_pack', 'additional_unit', 'shipping')),
        CONSTRAINT billing_manual_overrides_order_line_unq
          UNIQUE (order_id, line_type)
      )
    `;
    await pg`ALTER TABLE billing_manual_overrides ENABLE ROW LEVEL SECURITY`;
    await pg`
      CREATE INDEX IF NOT EXISTS billing_manual_overrides_client_order_idx
      ON billing_manual_overrides (client_id, order_id)
    `;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

function normalizeLineType(value: unknown): ManualBillingOverrideLineType | null {
  const text = String(value ?? '').trim();
  return MANUAL_BILLING_OVERRIDE_TYPE_SET.has(text)
    ? (text as ManualBillingOverrideLineType)
    : null;
}

function money(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

export function manualBillingOverrideLabel(lineType: string): string {
  switch (lineType) {
    case 'shipping':
      return 'Shipping override';
    case 'package_cost':
      return 'Manual override';
    case 'pick_pack':
    case 'additional_unit':
      return 'Manual override';
    default:
      return 'Manual override';
  }
}

function manualBillingDescription(
  lineType: ManualBillingOverrideLineType,
  orderNumber: string | null,
  orderId: number | null,
): string {
  const target = orderNumber ?? orderId ?? 'unknown';
  switch (lineType) {
    case 'pick_pack':
      return `Manual Pick & Pack override for order ${target}`;
    case 'additional_unit':
      return `Manual Additional Units override for order ${target}`;
    case 'shipping':
      return `Manual Shipping override for order ${target}`;
  }
}

export async function readBillingManualOverrides(
  orderIds: number[],
): Promise<Map<number, BillingManualOverrideRow[]>> {
  const out = new Map<number, BillingManualOverrideRow[]>();
  const ids = [...new Set(orderIds.filter((id) => Number.isFinite(id)))];
  if (!ids.length) return out;
  try {
    await ensureBillingManualOverridesSchema();
    const rows = await pg<Array<{
      orderId: number;
      clientId: number;
      lineType: string;
      amount: string | number;
      reviewer: string | null;
      reviewedAt: string | null;
      note: string | null;
    }>>`
      SELECT order_id AS "orderId",
             client_id AS "clientId",
             line_type AS "lineType",
             amount::text AS amount,
             reviewer,
             reviewed_at AS "reviewedAt",
             note
      FROM billing_manual_overrides
      WHERE order_id = ANY(${ids})
    `;
    for (const row of rows) {
      const lineType = normalizeLineType(row.lineType);
      if (!lineType) continue;
      const orderId = Number(row.orderId);
      const next: BillingManualOverrideRow = {
        orderId,
        clientId: Number(row.clientId),
        lineType,
        amount: Number(row.amount),
        reviewer: row.reviewer ?? null,
        reviewedAt: row.reviewedAt ?? null,
        note: row.note ?? null,
      };
      const bucket = out.get(orderId) ?? [];
      bucket.push(next);
      out.set(orderId, bucket);
    }
  } catch (err) {
    console.warn(
      '[billing-manual-overrides] read skipped:',
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}

export async function upsertBillingManualOverride(
  input: BillingManualOverrideUpsert,
  executor: BillingManualOverrideExecutor = db,
): Promise<void> {
  await ensureBillingManualOverridesSchema();
  const lineType = normalizeLineType(input.lineType);
  if (!lineType) {
    throw new Error(`Unsupported manual billing override line type: ${input.lineType}`);
  }
  await executor.execute(drizzleSql`
    INSERT INTO billing_manual_overrides
      (order_id, client_id, line_type, amount, reviewer, reviewed_at, note, updated_at)
    VALUES (
      ${input.orderId}, ${input.clientId}, ${lineType},
      ${money(input.amount)}::numeric, ${input.reviewer}, now(), ${input.note}, now()
    )
    ON CONFLICT (order_id, line_type) DO UPDATE
      SET client_id = EXCLUDED.client_id,
          amount = EXCLUDED.amount,
          reviewer = EXCLUDED.reviewer,
          reviewed_at = now(),
          note = EXCLUDED.note,
          updated_at = now()
  `);
}

export function applyManualBillingOverrides<T extends ManualBillingLine>(
  lineItems: readonly T[],
  overrides: readonly BillingManualOverrideRow[],
  base: ManualBillingLineBase,
): T[] {
  const byType = new Map<ManualBillingOverrideLineType, BillingManualOverrideRow>();
  for (const override of overrides) {
    const lineType = normalizeLineType(override.lineType);
    if (!lineType || !Number.isFinite(override.amount)) continue;
    byType.set(lineType, override);
  }
  if (!byType.size) return lineItems as T[];

  const seen = new Set<ManualBillingOverrideLineType>();
  const output: T[] = [];
  const shippingOverridden = byType.has('shipping');

  for (const line of lineItems) {
    if (shippingOverridden && line.lineType === 'shipping_missing') continue;
    const lineType = normalizeLineType(line.lineType);
    const override = lineType ? byType.get(lineType) : undefined;
    if (!override || !lineType) {
      output.push(line);
      continue;
    }
    seen.add(lineType);
    const amount = money(override.amount);
    output.push({
      ...line,
      qty: '1.00',
      unitCost: amount,
      totalCost: amount,
    });
  }

  for (const [lineType, override] of byType) {
    if (seen.has(lineType)) continue;
    const amount = money(override.amount);
    output.push({
      ...base,
      lineType,
      description: manualBillingDescription(lineType, base.orderNumber, base.orderId),
      qty: '1.00',
      unitCost: amount,
      totalCost: amount,
    } as T);
  }

  return output;
}
