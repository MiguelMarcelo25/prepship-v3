#!/usr/bin/env tsx
/**
 * PS-207 read-only dry-run — run the NEW shipped-box resolver over the real
 * Heritage Kids Press audit orders (SP6745..SP6763 class) and report what one
 * "Update Billing" would produce per order, next to DJ's expected table:
 *
 *   SP6755 / SP6759  12x10x3        $0.00 today   → $0.55
 *   SP6745           12x10x3        $0.55         → $0.55
 *   SP6760           11x9x6         $0.74         → $0.74
 *   SP6754           Custom 12x10x1 $0.55 (wrong) → NEEDS REVIEW
 *   SP6753 / SP6763  Custom 11.5x9x3 $0.74 (SKU)  → NEEDS REVIEW
 *
 * STRICTLY READ-ONLY: selects only; no billing regeneration, no line/order/
 * shipment mutation, no DDL (a missing billing_box_resolutions table is
 * treated as "no operator resolutions yet"). Redacted output: order numbers,
 * dims, package names, amounts — no addresses/PII/labels.
 *
 *   npx tsx scripts/ps-207-hkp-box-resolution-dryrun.ts [clientNameLike]
 */
import 'dotenv/config';
import postgres from 'postgres';
import {
  boxDimsKey,
  decidePackageCostLine,
  resolveShippedPackageId,
  type BoxLookups,
  type BoxPackage,
  type OperatorBoxResolution,
} from '../src/services/billing-box-policy';

const sql = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false, connect_timeout: 10 });
const clientLike = process.argv[2] ?? '%heritage%';

async function main(): Promise<void> {
  const [client] = await sql<Array<{ id: number; name: string }>>`
    SELECT id, name FROM clients WHERE name ILIKE ${clientLike} AND active = true ORDER BY id LIMIT 1
  `;
  if (!client) {
    console.log(`no active client matching ${clientLike}`);
    return;
  }

  const pkgRows = await sql<Array<BoxPackage>>`
    SELECT id, name, package_code as "packageCode", length, width, height FROM packages
  `;
  const byId = new Map(pkgRows.map((p) => [p.id, p]));
  const byCode = new Map(pkgRows.filter((p) => p.packageCode).map((p) => [p.packageCode!, p]));
  const byDims = new Map(
    pkgRows
      .map((p) => [boxDimsKey(p.length, p.width, p.height), p] as const)
      .filter((e): e is [string, BoxPackage] => e[0] !== null)
  );
  const lookups: BoxLookups = { byId, byCode, byDims };

  const priceRows = await sql<Array<{ package_id: number; price: string }>>`
    SELECT package_id, price FROM client_package_prices WHERE client_id = ${client.id}
  `;
  const prices = new Map(priceRows.map((r) => [r.package_id, Number(r.price)]));
  const [cfg] = await sql<Array<{ package_cost_markup: string | null }>>`
    SELECT package_cost_markup FROM billing_config WHERE client_id = ${client.id}
  `;
  const markupPct = Number(cfg?.package_cost_markup ?? 0) || 0;

  // Operator resolutions — table may not exist pre-deploy; READ-ONLY means we
  // do not create it here.
  let resolutions = new Map<number, OperatorBoxResolution>();
  try {
    const rows = await sql<Array<{ order_id: number; package_id: number | null; override_price: string | null; note: string | null }>>`
      SELECT order_id, package_id, override_price, note FROM billing_box_resolutions
    `;
    resolutions = new Map(rows.map((r) => [r.order_id, {
      packageId: r.package_id,
      overridePrice: r.override_price != null ? Number(r.override_price) : null,
      note: r.note,
    }]));
  } catch {
    console.log('billing_box_resolutions not present yet (pre-deploy) — no operator resolutions.');
  }

  const shipRows = await sql<Array<{
    order_id: number;
    order_number: string;
    selected_pid: number | null;
    selected_package_id: string | null;
    dims_l: number | null;
    dims_w: number | null;
    dims_h: number | null;
    current_box_total: string | null;
    current_box_desc: string | null;
  }>>`
    SELECT o.id as order_id, o.order_number,
           s.selected_pid, s.selected_package_id, s.dims_l, s.dims_w, s.dims_h,
           b.total_cost as current_box_total, b.description as current_box_desc
    FROM orders o
    JOIN shipments s ON s.order_id = o.id AND s.voided = false
    LEFT JOIN billing_line_items b
      ON b.order_id = o.id AND b.line_type = 'package_cost'
    WHERE o.client_id = ${client.id}
      AND o.order_status = 'shipped'
    ORDER BY o.id DESC
    LIMIT 40
  `;

  console.log(`\nPS-207 dry-run — client ${client.id} (${client.name}) · box prices configured: ${prices.size} · markup ${markupPct}%`);
  console.log('order        shipment box           current bill      → new policy');
  console.log('─'.repeat(86));
  let reviews = 0;
  for (const r of shipRows) {
    const resolution = resolveShippedPackageId({
      operator: resolutions.get(r.order_id) ?? null,
      selectedPid: r.selected_pid,
      selectedPackageId: r.selected_package_id,
      dimsL: r.dims_l, dimsW: r.dims_w, dimsH: r.dims_h,
      lookups,
    });
    const decision = decidePackageCostLine({
      resolution,
      clientHasBoxPricing: prices.size > 0,
      configuredPrice:
        resolution.status === 'resolved' && resolution.packageId != null
          ? prices.get(resolution.packageId)
          : undefined,
      markupPct,
    });
    const dims = [r.dims_l, r.dims_w, r.dims_h].every((v) => v != null && Number(v) > 0)
      ? `${r.dims_l}x${r.dims_w}x${r.dims_h}`
      : 'no-dims';
    const sel = r.selected_package_id ?? (r.selected_pid != null ? `pid:${r.selected_pid}` : '—');
    const current = r.current_box_total != null ? `$${Number(r.current_box_total).toFixed(2)}` : '(no box line)';
    const outcome =
      decision.kind === 'line'
        ? `$${decision.amount.toFixed(2)} (${decision.pkgName})`
        : decision.kind === 'review'
          ? `NEEDS REVIEW — ${decision.description}`
          : 'no line (free/unpriced or no box pricing)';
    if (decision.kind === 'review') reviews += 1;
    console.log(`${r.order_number.padEnd(12)} dims=${dims.padEnd(12)} sel=${String(sel).padEnd(14)} ${current.padEnd(14)} → ${outcome}`);
  }
  console.log('─'.repeat(86));
  console.log(`rows: ${shipRows.length} · review wave on first regeneration: ${reviews}`);
  console.log('READ-ONLY run — no billing rows, orders, shipments, or resolutions were written.');

  await sql.end({ timeout: 5 });
}

void main();
