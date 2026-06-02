/**
 * PS-068 — read-only billing pricing diagnostic.
 *
 * Reports, for one client + package across ALL generated billing, whether the
 * package_cost billing_line_items reflect the current client_package_prices
 * price (after billing_config.package_cost_markup), how many rows are stale at
 * the old price, the expected box-cost delta if billing were regenerated,
 * whether the cached billing_summary_metrics.package_total agrees with the
 * live package_cost detail rows, and which package_id the generator's dims
 * resolver would actually pick for that box (to confirm it matches).
 *
 * READ-ONLY. No mutations. Redacted output only — aggregate counts and prices,
 * no order numbers (beyond ids), SKUs, addresses, or customer data.
 *
 *   npx tsx scripts/ps-068-billing-pricing-diagnostic.ts [clientId] [packageId]
 *
 * Defaults: clientId=4 (HUGRAB), packageId=121 ("12x10x3").
 */
import { sql } from '../src/db/client';

const clientId = Number.parseInt(process.argv[2] ?? '', 10) || 4;
const packageId = Number.parseInt(process.argv[3] ?? '', 10) || 121;

// Penny-tolerant equality for numeric($,2) comparisons.
const EPS = 0.005;
function n(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function money(v: number): string {
  const s = v < 0 ? '-' : '';
  return `${s}$${Math.abs(v).toFixed(2)}`;
}
function line(): void {
  console.log('-'.repeat(64));
}

async function main(): Promise<void> {
  console.log(`PS-068 billing pricing diagnostic (read-only)`);
  console.log(`clientId=${clientId}  packageId=${packageId}`);
  line();

  // ── 1. Current effective package price ───────────────────────────────────
  // base price from client_package_prices × (1 + package_cost_markup/100).
  const priceRows = await sql<
    {
      base_price: string | null;
      is_custom: boolean | null;
      price_updated_at: string | null;
      markup_pct: string | null;
      pkg_name: string | null;
    }[]
  >`
    select
      cpp.price            as base_price,
      cpp.is_custom        as is_custom,
      cpp.updated_at       as price_updated_at,
      bc.package_cost_markup as markup_pct,
      p.name               as pkg_name
    from packages p
    left join client_package_prices cpp
      on cpp.client_id = ${clientId} and cpp.package_id = ${packageId}
    left join billing_config bc
      on bc.client_id = ${clientId}
    where p.id = ${packageId}
  `;

  if (priceRows.length === 0) {
    console.log(`Package id ${packageId} not found. Aborting.`);
    process.exit(1);
  }

  const pr = priceRows[0];
  const pkgName = pr.pkg_name ?? `Box #${packageId}`;
  const basePrice = pr.base_price === null ? null : n(pr.base_price);
  const markupPct = n(pr.markup_pct);
  const effectivePrice =
    basePrice === null ? null : Number((basePrice * (1 + markupPct / 100)).toFixed(2));

  console.log(`Package name           : ${pkgName}`);
  console.log(
    `Base price (custom?)   : ${basePrice === null ? '(no price row)' : money(basePrice)}` +
      ` ${pr.is_custom ? '(custom)' : pr.base_price === null ? '' : '(default)'}`
  );
  console.log(`package_cost_markup    : ${markupPct.toFixed(2)}%`);
  console.log(
    `Effective box price    : ${effectivePrice === null ? '(n/a)' : money(effectivePrice)}`
  );
  console.log(`price.updated_at       : ${pr.price_updated_at ?? '(none)'}`);
  line();

  // ── 2. Distinct unit_cost values on existing package_cost rows for this box ─
  // Matched by client + the generated "Box (<pkgName>)" description, which is
  // how generateLineItems labels every package_cost row for this package.
  const desc = `Box (${pkgName})`;
  const distinctRows = await sql<{ unit_cost: string; row_count: string }[]>`
    select unit_cost, count(*) as row_count
    from billing_line_items
    where client_id = ${clientId}
      and line_type = 'package_cost'
      and description = ${desc}
    group by unit_cost
    order by unit_cost
  `;

  console.log(`Existing package_cost rows for "${desc}":`);
  if (distinctRows.length === 0) {
    console.log('  (none generated)');
  } else {
    console.log('  unit_cost    rows');
    for (const r of distinctRows) {
      console.log(`  ${money(n(r.unit_cost)).padEnd(11)} ${r.row_count}`);
    }
  }
  line();

  // ── 3. Rows at OLD vs NEW/current effective price + regenerate delta ──────
  let atCurrent = 0;
  let atOld = 0;
  let oldSumDelta = 0; // sum over stale rows of (effective - existing)
  for (const r of distinctRows) {
    const uc = n(r.unit_cost);
    const cnt = n(r.row_count);
    if (effectivePrice !== null && Math.abs(uc - effectivePrice) <= EPS) {
      atCurrent += cnt;
    } else {
      atOld += cnt;
      if (effectivePrice !== null) oldSumDelta += (effectivePrice - uc) * cnt;
    }
  }

  console.log(
    `Rows at CURRENT effective price ${effectivePrice === null ? '(n/a)' : money(effectivePrice)}: ${atCurrent}`
  );
  console.log(`Rows at a DIFFERENT (old) price                 : ${atOld}`);
  console.log(
    `Expected box-cost delta if regenerated          : ${money(oldSumDelta)}` +
      ` (over ${atOld} stale row${atOld === 1 ? '' : 's'})`
  );
  if (atOld > 0 && effectivePrice !== null) {
    console.log(
      `  -> regenerating re-prices ${atOld} row(s) to ${money(effectivePrice)} each.`
    );
  }
  line();

  // ── 4. Summary cache vs live detail consistency ──────────────────────────
  // billing_summary_metrics.package_total is a cached SUM(total_cost where
  // line_type='package_cost') per (client, period). The cache is windowed by
  // ship_date per period, so we compare the cached total across ALL periods
  // for this client against the live SUM of all package_cost detail rows for
  // this client (both line_type-scoped). A mismatch flags a stale cache.
  const sumRows = await sql<
    { summary_package_total: string | null; detail_package_total: string | null }[]
  >`
    select
      (select coalesce(sum(package_total), 0)
         from billing_summary_metrics
        where client_id = ${clientId}) as summary_package_total,
      (select coalesce(sum(total_cost), 0)
         from billing_line_items
        where client_id = ${clientId}
          and line_type = 'package_cost') as detail_package_total
  `;
  const summaryTotal = n(sumRows[0]?.summary_package_total);
  const detailTotal = n(sumRows[0]?.detail_package_total);
  const mismatch = Math.abs(summaryTotal - detailTotal) > EPS;
  console.log(`Summary cache package_total (all periods): ${money(summaryTotal)}`);
  console.log(`Live detail package_cost SUM (all rows)  : ${money(detailTotal)}`);
  console.log(
    `Consistency                              : ${mismatch ? `MISMATCH (delta ${money(detailTotal - summaryTotal)})` : 'OK (match)'}`
  );
  if (mismatch) {
    console.log(
      '  NOTE: summary is a windowed cache (per period_from/period_to); a delta'
    );
    console.log(
      '  can mean a stale 45-min cache or detail rows outside any cached window.'
    );
  }
  line();

  // ── 5. Which package_id the dims resolver actually picks for this box ─────
  // generateLineItems builds packagesByDims / packagesByRoundedDims from ALL
  // packages and resolves dims with last-writer-wins on collision. We replay
  // that here to confirm dims for package ${packageId} actually resolve back to
  // it (and surface any collision that would silently bill a different box).
  const dimRows = await sql<
    { id: number; name: string; length: number; width: number; height: number }[]
  >`
    select id, name, length, width, height
    from packages
    order by id
  `;
  const target = dimRows.find((d) => d.id === packageId) ?? null;

  if (!target || n(target.length) <= 0 || n(target.width) <= 0 || n(target.height) <= 0) {
    console.log('Dims resolver               : package has no usable dims; resolves by SKU/code/selected-pid only.');
  } else {
    const exactKey = (l: number, w: number, h: number) => `${l}×${w}×${h}`;
    const roundKey = (l: number, w: number, h: number) =>
      `${Math.round(l)}x${Math.round(w)}x${Math.round(h)}`;
    const byDims = new Map<string, number>();
    const byRounded = new Map<string, number>();
    for (const d of dimRows) {
      const l = n(d.length);
      const w = n(d.width);
      const h = n(d.height);
      if (l > 0 && w > 0 && h > 0) {
        byDims.set(exactKey(l, w, h), d.id); // last writer wins (matches generate)
        byRounded.set(roundKey(l, w, h), d.id);
      }
    }
    const tl = n(target.length);
    const tw = n(target.width);
    const th = n(target.height);
    const resolvedExact = byDims.get(exactKey(tl, tw, th)) ?? null;
    const resolvedRounded = byRounded.get(roundKey(tl, tw, th)) ?? null;
    const resolved = resolvedExact ?? resolvedRounded;
    console.log(`Target box dims (L×W×H)      : ${tl}×${tw}×${th}`);
    console.log(`Dims resolves to package id  : exact=${resolvedExact ?? '-'} rounded=${resolvedRounded ?? '-'}`);
    console.log(
      `Matches expected (${packageId})?        : ${resolved === packageId ? 'YES' : `NO -> resolves to ${resolved ?? 'none'} (dims collision)`}`
    );
  }
  line();

  console.log('Diagnostic complete (no rows mutated).');
  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch(async (err) => {
  console.error('PS-068 diagnostic failed:', err instanceof Error ? err.message : err);
  try {
    await sql.end({ timeout: 5 });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
