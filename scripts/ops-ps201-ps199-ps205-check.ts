#!/usr/bin/env tsx
/**
 * Ops check (DJ directive 2026-06-12) — three read-mostly verifications:
 *
 *  A. PS-201 — the 5 Walmart ship-confirms that failed May 15–19: query the
 *     Walmart Marketplace API (READ-ONLY) per customerOrderId and report
 *     whether each order shows shipped/delivered with tracking on Walmart's
 *     side, next to OUR shipments-row tracking. No Seller Center writes —
 *     any manual confirm stays a human action.
 *  B. PS-199 — Walmart Browse Rates: resolve the purchaseOrderId for a real
 *     recent Walmart awaiting order ('rates' mode) and run ONE free
 *     walmart_shipping quote. $0 (estimates are free), read-only.
 *  C. PS-205 — HUGRAB combo booster-gel-001:2|hu-10:1: report every awaiting
 *     order's EFFECTIVE package facts via the canonical resolver (read-only).
 *     Rows imported before the PS-205 deploy that lack materialized facts are
 *     COUNTED and listed; pass --apply to run the production materializer
 *     over them (its own rails: awaiting-only, never overwrites operator
 *     facts, skips labelled rows). Default is dry-run / read-only.
 *
 *   npx tsx scripts/ops-ps201-ps199-ps205-check.ts          # read-only
 *   npx tsx scripts/ops-ps201-ps199-ps205-check.ts --apply  # + materialize backfill
 */
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false, connect_timeout: 10 });

const PS201 = [
  { shipmentId: 24399, customerOrderId: '200014672076136', failedOn: '2026-05-19' },
  { shipmentId: 24256, customerOrderId: '200014861418723', failedOn: '2026-05-15' },
  { shipmentId: 24252, customerOrderId: '200014865882035', failedOn: '2026-05-15' },
  { shipmentId: 24257, customerOrderId: '200014391190968', failedOn: '2026-05-15' },
  { shipmentId: 24258, customerOrderId: '200014770498089', failedOn: '2026-05-15' },
];

function walmartLineSummary(rawOrder: unknown): { statuses: string[]; tracking: string[] } {
  const statuses: string[] = [];
  const tracking: string[] = [];
  const lines = (rawOrder as any)?.orderLines?.orderLine;
  const list = Array.isArray(lines) ? lines : lines ? [lines] : [];
  for (const line of list) {
    const sts = (line as any)?.orderLineStatuses?.orderLineStatus;
    const stList = Array.isArray(sts) ? sts : sts ? [sts] : [];
    for (const st of stList) {
      if (st?.status) statuses.push(String(st.status));
      const tn = st?.trackingInfo?.trackingNumber;
      if (tn) tracking.push(String(tn));
    }
  }
  return { statuses: [...new Set(statuses)], tracking: [...new Set(tracking)] };
}

async function main(): Promise<void> {
  const { lookupWalmartOrderByCustomerOrderId } = await import('../src/connectors/store/walmart.js');
  const { resolveWalmartPurchaseOrder } = await import('../src/services/walmart-po-resolution.js');
  const { quoteCarrierRates } = await import('../src/services/carrier-connector-orchestrator.js');
  const { resolveOrderPackageFacts, materializePackageFactsForImportedOrders } = await import('../src/services/combo-package-defaults.js');
  const { computeComboKey } = await import('../src/lib/package-combo.js');

  // Marketplace credentials: the Walmart STORE account row.
  const [walmartStore] = await sql`
    SELECT id, label, credentials FROM store_accounts
    WHERE lower(provider) = 'walmart' AND active IS DISTINCT FROM false
    ORDER BY id LIMIT 1
  `;
  const marketplaceCreds = (walmartStore?.credentials ?? {}) as Record<string, unknown>;

  console.log('\n══ A. PS-201 — Walmart-side status of the 5 failed ship-confirms ══');
  if (!walmartStore) {
    console.log('no active walmart store_accounts row — cannot query the Marketplace API');
  } else {
    for (const item of PS201) {
      const [ours] = await sql`
        SELECT tracking_number, carrier_code, confirmation_status, confirmation_attempts
        FROM shipments WHERE id = ${item.shipmentId}
      `;
      let walmartSide = 'LOOKUP FAILED';
      try {
        const looked = await lookupWalmartOrderByCustomerOrderId(marketplaceCreds, item.customerOrderId);
        if (!looked) walmartSide = 'NOT FOUND via customerOrderId lookup';
        else {
          const { statuses, tracking } = walmartLineSummary(looked.rawOrder);
          const ourTn = String(ours?.tracking_number ?? '');
          const trackingMatch = ourTn && tracking.some((t) => t === ourTn);
          walmartSide = `PO ${looked.purchaseOrderId} · lines: ${statuses.join('/') || 'unknown'} · wm-tracking: ${tracking.length ? tracking.join(',') : 'none'} · matches ours: ${trackingMatch ? 'YES' : 'NO'}`;
        }
      } catch (err) {
        walmartSide = `lookup error: ${err instanceof Error ? err.message : String(err)}`;
      }
      console.log(
        `  shipment ${item.shipmentId} (failed ${item.failedOn}) · co#${item.customerOrderId}\n` +
        `    ours: ${ours?.carrier_code ?? '?'} ${ours?.tracking_number ?? 'no tracking'} · confirm=${ours?.confirmation_status} (${ours?.confirmation_attempts} attempts)\n` +
        `    walmart: ${walmartSide}`,
      );
    }
  }

  console.log('\n══ B. PS-199 — Walmart PO resolution + ONE free walmart_shipping quote ══');
  const [wsAccount] = await sql`
    SELECT id, label, credentials FROM carrier_accounts
    WHERE lower(provider) = 'walmart_shipping' AND active IS DISTINCT FROM false
    ORDER BY id LIMIT 1
  `;
  // Direct-pulled Walmart orders carry a 'walmart-' external id; ShipStation-
  // pulled Walmart-DJC orders don't — fall back to the Walmart client's most
  // recent awaiting order (PS-199 resolves those via order_number candidates).
  const [recentWalmartOrder] = await sql`
    SELECT o.id, o.order_number, o.external_order_id, o.ship_to_postal_code,
           coalesce(ov.rate_weight_oz, o.weight_oz) AS weight_oz,
           ov.rate_dims_l, ov.rate_dims_w, ov.rate_dims_h
    FROM orders o
    LEFT JOIN order_overrides ov ON ov.order_id = o.id
    LEFT JOIN clients c ON c.id = o.client_id
    WHERE o.order_status = 'awaiting_shipment'
      AND (o.external_order_id LIKE 'walmart-%' OR upper(coalesce(c.name, '')) LIKE '%WALMART%')
    ORDER BY o.id DESC LIMIT 1
  `;
  if (!wsAccount || !recentWalmartOrder) {
    console.log(`skipped — walmart_shipping account: ${Boolean(wsAccount)}, recent walmart awaiting order: ${Boolean(recentWalmartOrder)}`);
  } else {
    try {
      const resolution = await resolveWalmartPurchaseOrder(
        {
          purchaseOrderId: null,
          orderId: Number(recentWalmartOrder.id),
          externalOrderId: String(recentWalmartOrder.external_order_id),
          orderNumber: String(recentWalmartOrder.order_number),
          credentials: (wsAccount.credentials ?? {}) as Record<string, unknown>,
          storeAccountId: null,
        },
        'rates',
      );
      console.log(`  order #${recentWalmartOrder.order_number} (id ${recentWalmartOrder.id}) → PO ${resolution?.purchaseOrderId ?? 'NONE'} via ${resolution?.purchaseOrderSource ?? '-'}`);
      const quoted = await quoteCarrierRates('walmart_shipping', {
        credentials: (wsAccount.credentials ?? {}) as Record<string, unknown>,
        weightOz: Number(recentWalmartOrder.weight_oz ?? 16),
        toZip: String(recentWalmartOrder.ship_to_postal_code ?? ''),
        dimsL: Number(recentWalmartOrder.rate_dims_l ?? 10),
        dimsW: Number(recentWalmartOrder.rate_dims_w ?? 8),
        dimsH: Number(recentWalmartOrder.rate_dims_h ?? 4),
        purchaseOrderId: resolution?.purchaseOrderId,
        ...(resolution?.rawOrder != null ? { rawOrder: resolution.rawOrder } : {}),
      } as never);
      const rates = Array.isArray((quoted as any)?.rates) ? (quoted as any).rates : [];
      const sample = rates.slice(0, 3).map((r: any) => `${r.serviceCode ?? r.service ?? '?'} $${r.cost ?? r.price ?? r.amount ?? '?'}`).join(' · ');
      console.log(`  walmart_shipping quote: ${rates.length} rate(s)${rates.length ? ` — ${sample}` : ''} ($0 spent — estimates are free)`);
    } catch (err) {
      console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n══ C. PS-205 — HUGRAB booster-gel-001:2|hu-10:1 effective package facts ══');
  const TARGET_COMBO = 'booster-gel-001:2|hu-10:1';
  const hugrabOrders = await sql`
    SELECT o.id, o.order_number, o.external_order_id, o.items, o.weight_oz,
           ov.rate_weight_oz, ov.rate_dims_l, ov.rate_dims_w, ov.rate_dims_h, ov.selected_package_id
    FROM orders o
    LEFT JOIN order_overrides ov ON ov.order_id = o.id
    JOIN clients c ON c.id = o.client_id
    WHERE o.order_status = 'awaiting_shipment' AND upper(c.name) LIKE '%HUGRAB%'
    ORDER BY o.id DESC LIMIT 200
  `;
  const comboRows = hugrabOrders.filter((r) => computeComboKey((r.items as never) ?? []) === TARGET_COMBO);
  console.log(`  HUGRAB awaiting orders: ${hugrabOrders.length}; matching the combo: ${comboRows.length}`);
  const needsMaterialize: string[] = [];
  for (const r of comboRows) {
    const facts = await resolveOrderPackageFacts(Number(r.id));
    const overrideWeight = r.rate_weight_oz;
    if (overrideWeight == null && r.selected_package_id == null && r.rate_dims_l == null) {
      needsMaterialize.push(String(r.external_order_id ?? ''));
    }
    console.log(
      `  #${r.order_number} (id ${r.id}) · imported=${r.weight_oz}oz · override=${overrideWeight ?? '-'}oz · ` +
      `EFFECTIVE: ${facts?.weightOz ?? '?'}oz ${facts?.dims ? `${facts.dims.length}x${facts.dims.width}x${facts.dims.height}` : 'no-dims'} pkg=${facts?.selectedPackageId ?? '-'} (source: ${facts?.source ?? '?'})`,
    );
  }
  const backfillIds = needsMaterialize.filter(Boolean);
  const apply = process.argv.includes('--apply');
  if (!backfillIds.length) {
    console.log('  all combo rows already carry materialized/override facts ✓');
  } else if (!apply) {
    console.log(
      `  → ${backfillIds.length} row(s) lack materialized facts (imported pre-deploy). ` +
      'DRY-RUN: no writes performed. Re-run with --apply to run the production materializer ' +
      '(rails: awaiting-only, never overwrites operator facts, labelled rows skipped).',
    );
  } else {
    console.log(`  → APPLY: materializing ${backfillIds.length} row(s) via the production materializer…`);
    const result = await materializePackageFactsForImportedOrders(backfillIds);
    console.log(`  materializer: examined ${result.examined}, materialized ${result.materialized}, invalidated rates: [${result.invalidatedOrderIds.join(', ')}]`);
    for (const r of comboRows) {
      const facts = await resolveOrderPackageFacts(Number(r.id));
      console.log(`  recheck #${r.order_number}: EFFECTIVE ${facts?.weightOz ?? '?'}oz (source: ${facts?.source ?? '?'})`);
    }
  }

  await sql.end({ timeout: 5 });
}

void main();
