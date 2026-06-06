#!/usr/bin/env tsx
/**
 * Print-to-Queue PREFLIGHT — runs your REAL awaiting-shipment orders through the
 * exact preconditions the real buy path enforces, STOPPING one step before any
 * postage is purchased. Read-only: SELECT only, no writes, no labels, no money,
 * no marketplace, no shipped-status changes.
 *
 * Answers "will print-to-queue error on my real orders?" by reporting, per order:
 *   READY ✅   — all preconditions met; print-to-queue will not error on our side
 *   WOULD ERROR ❌ — with the exact reason(s), mirroring the real thrown errors
 *
 * Requirements mirrored from api/carriers/labels.ts (direct carriers) and the
 * createLabel path:
 *   - order is editable (not shipped/cancelled)         (labels.ts:1151)
 *   - weightOz + dimsL/W/H all present                  (labels.ts:1007)
 *   - a selected/best rate exists with carrier+service+provider id
 *   - rate fields are scalar (no [object Object])
 *   - ship-to resolves: name, street1, city, state, zip (labels.ts:307/389)
 *
 * Usage:
 *   npm run preflight:print-queue                 # all awaiting_shipment
 *   npm run preflight:print-queue -- --limit 200
 *   npm run preflight:print-queue -- --client 3
 *   npm run preflight:print-queue -- --store 101
 *   npm run preflight:print-queue -- --errors-only
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const OUT = 'test-results/preflight/print-queue';

function rawShipToStreet(raw: any): string {
  const s = raw?.shipTo ?? raw?.ship_to ?? {};
  return String(s.street1 ?? s.address1 ?? s.addressLine1 ?? s.address_line1 ?? '').trim();
}

function isScalar(v: unknown): boolean {
  return v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

type Category = 'ready' | 'would_error' | 'not_rated';

/**
 * Classifies one order. A rate is the operator's "this order is prepped to ship"
 * signal — so we only call an order WOULD_ERROR if it HAS a rate but would still
 * fail. Un-rated orders are NOT_RATED (normal; operator hasn't browsed rates yet),
 * not bugs.
 */
function preflightOrder(o: any): { category: Category; reasons: string[] } {
  if (o.order_status === 'shipped' || o.order_status === 'cancelled') {
    return { category: 'would_error', reasons: [`order is ${o.order_status} (not editable)`] };
  }

  const rate = o.best_rate_json;
  const hasRate = rate && typeof rate === 'object';
  if (!hasRate) {
    return { category: 'not_rated', reasons: ['not rated yet (operator must browse rates before print-to-queue)'] };
  }

  // The order is RATED — now it must actually be printable. Anything failing here
  // is a real bug that would error at print-to-queue.
  const reasons: string[] = [];

  // dimensions + weight (a rated order should already have these)
  const weightOz = Number(o.rate_weight_oz ?? o.weight_oz ?? 0);
  if (!(weightOz > 0)) reasons.push('rated but missing weight');
  const l = Number(o.rate_dims_l ?? 0), w = Number(o.rate_dims_w ?? 0), h = Number(o.rate_dims_h ?? 0);
  if (!(l > 0 && w > 0 && h > 0)) reasons.push('rated but missing dimensions (L/W/H)');

  // rate shape — accept both the modern camelCase and legacy snake_case schemas
  const carrierCode = rate.carrierCode ?? rate.carrier_code;
  const serviceCode = rate.serviceCode ?? rate.service_code;
  const providerId = rate.shippingProviderId ?? rate.providerAccountId ?? rate.carrierId ?? rate.carrier_id;
  if (!carrierCode) reasons.push('rate missing carrierCode');
  if (!serviceCode) reasons.push('rate missing serviceCode');
  if (providerId == null) reasons.push('rate missing provider/account id');
  for (const k of ['carrierCode', 'serviceCode', 'serviceName', 'carrierNickname', 'amount', 'cost']) {
    if (k in rate && !isScalar(rate[k])) reasons.push(`rate.${k} is not a scalar (would render [object Object])`);
  }

  // ship-to completeness
  const name = String(o.ship_to_name ?? '').trim();
  const street1 = rawShipToStreet(o.raw);
  const city = String(o.ship_to_city ?? '').trim();
  const state = String(o.ship_to_state ?? '').trim();
  const zip = String(o.ship_to_postal_code ?? '').trim();
  const missing = [
    !name && 'name', !street1 && 'street1', !city && 'city', !state && 'state', !zip && 'zip',
  ].filter(Boolean);
  if (missing.length) reasons.push(`incomplete ship-to (${missing.join(', ')})`);

  return { category: reasons.length === 0 ? 'ready' : 'would_error', reasons };
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL not set — preflight needs to read your real orders.');
    process.exit(2);
  }
  const limit = Number(flag('limit') ?? '0') || null;
  const client = flag('client');
  const store = flag('store');
  const errorsOnly = has('errors-only');
  // By default exclude the legacy SEAuto-* backlog and TESTING-* data — they are
  // not part of the daily print-to-queue flow and drown out the real signal.
  const includeLegacy = has('include-legacy');

  const postgres = (await import('postgres')).default;
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 });

  try {
    const rows = (await sql`
      SELECT o.id, o.order_number, o.order_status, o.weight_oz, o.client_id, o.store_id,
             o.ship_to_name, o.ship_to_city, o.ship_to_state, o.ship_to_postal_code, o.raw,
             ov.rate_weight_oz, ov.rate_dims_l, ov.rate_dims_w, ov.rate_dims_h,
             ov.best_rate_json, ov.best_rate_at
      FROM orders o
      LEFT JOIN order_overrides ov ON ov.order_id = o.id
      WHERE o.order_status = 'awaiting_shipment'
        ${includeLegacy ? sql`` : sql`AND o.order_number NOT LIKE 'SEAuto-%' AND o.order_number NOT LIKE 'TESTING-%'`}
        ${client ? sql`AND o.client_id = ${Number(client)}` : sql``}
        ${store ? sql`AND o.store_id = ${Number(store)}` : sql``}
      ORDER BY o.order_date DESC NULLS LAST, o.id DESC
      ${limit ? sql`LIMIT ${limit}` : sql``}
    `) as any[];

    if (!includeLegacy) {
      const [{ n: legacyCount }] = (await sql`
        SELECT count(*)::int AS n FROM orders
        WHERE order_status = 'awaiting_shipment' AND (order_number LIKE 'SEAuto-%' OR order_number LIKE 'TESTING-%')
      `) as Array<{ n: number }>;
      if (legacyCount > 0) console.log(`\n(excluding ${legacyCount} legacy SEAuto-*/TESTING-* orders; pass --include-legacy to include)`);
    }

    const results = rows.map((o) => {
      const { category, reasons } = preflightOrder(o);
      return { id: o.id, orderNumber: o.order_number, clientId: o.client_id, category, reasons };
    });
    const ready = results.filter((r) => r.category === 'ready');
    const wouldError = results.filter((r) => r.category === 'would_error');
    const notRated = results.filter((r) => r.category === 'not_rated');

    // Reason frequency for the genuinely-broken orders only.
    const freq = new Map<string, number>();
    for (const r of wouldError) for (const reason of r.reasons) {
      const key = reason.replace(/\(.*\)/, '').trim();
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }

    mkdirSync('test-results/preflight', { recursive: true });
    writeFileSync(`${OUT}.json`, JSON.stringify({ total: results.length, ready: ready.length, wouldError: wouldError.length, notRated: notRated.length, results }, null, 2));

    console.log(`\nPrint-to-Queue Preflight — ${results.length} real awaiting-shipment order(s)`);
    console.log(`  ✅ READY (rated + printable)   ${ready.length}`);
    console.log(`  ❌ WOULD ERROR (rated, broken) ${wouldError.length}`);
    console.log(`  ⏳ NOT RATED YET (normal)      ${notRated.length}\n`);
    console.log(`  Of ${ready.length + wouldError.length} rated orders, ${wouldError.length} would error at print-to-queue.\n`);

    if (freq.size) {
      console.log('Real blocking bugs (rated orders only):');
      [...freq.entries()].sort((a, b) => b[1] - a[1]).forEach(([reason, n]) => console.log(`  ${String(n).padStart(4)} × ${reason}`));
      console.log('');
    }

    // Always show the genuinely-broken ones. Show READY/NOT-RATED only without --errors-only.
    for (const r of wouldError) {
      console.log(`  ❌ WOULD ERROR #${r.orderNumber} (id ${r.id}, client ${r.clientId}) — ${r.reasons.join('; ')}`);
    }
    if (!errorsOnly) {
      for (const r of ready) console.log(`  ✅ READY       #${r.orderNumber} (id ${r.id}, client ${r.clientId})`);
      for (const r of notRated) console.log(`  ⏳ NOT RATED   #${r.orderNumber} (id ${r.id}, client ${r.clientId})`);
    }

    console.log(`\nReport: ${OUT}.json`);
    console.log(wouldError.length === 0
      ? `\n✅ All ${ready.length} rated orders are READY — print-to-queue will not error on our side. (${notRated.length} not rated yet; nothing bought or changed — read-only.)`
      : `\n⚠️  ${wouldError.length} RATED order(s) would error at print-to-queue — these are real bugs to fix. (${notRated.length} not rated yet. Nothing bought or changed — read-only.)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main();
