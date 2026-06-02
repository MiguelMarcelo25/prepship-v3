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
  // Rows carrying a manual billing-line box override (package_id is not null,
  // set via the Edit Billing Detail modal) hold a DELIBERATE operator cost, not
  // a stale generated price — they are reported separately and excluded from
  // the staleness count below (see PS-068 override row: HUGRAB order 1144598
  // overridden to pkg 212 "14x10x8" at $1.47).
  const desc = `Box (${pkgName})`;
  const distinctRows = await sql<
    { unit_cost: string; is_override: boolean; row_count: string }[]
  >`
    select unit_cost, (package_id is not null) as is_override, count(*) as row_count
    from billing_line_items
    where client_id = ${clientId}
      and line_type = 'package_cost'
      and description = ${desc}
    group by unit_cost, (package_id is not null)
    order by unit_cost
  `;

  const generatedRows = distinctRows.filter((r) => !r.is_override);
  const overrideRows = distinctRows.filter((r) => r.is_override);
  const overrideCount = overrideRows.reduce((acc, r) => acc + n(r.row_count), 0);

  console.log(`Existing GENERATED package_cost rows for "${desc}":`);
  if (generatedRows.length === 0) {
    console.log('  (none generated)');
  } else {
    console.log('  unit_cost    rows');
    for (const r of generatedRows) {
      console.log(`  ${money(n(r.unit_cost)).padEnd(11)} ${r.row_count}`);
    }
  }
  if (overrideCount > 0) {
    console.log(
      `  + ${overrideCount} manual box-override row(s) excluded from staleness` +
        ` (deliberate Edit Billing Detail edits; unit_cost is operator-set):`
    );
    for (const r of overrideRows) {
      console.log(`      override unit_cost ${money(n(r.unit_cost))} × ${r.row_count}`);
    }
  }
  line();

  // ── 3. Rows at OLD vs NEW/current effective price + regenerate delta ──────
  // Only GENERATED rows (no manual override) are subject to price staleness; a
  // regenerate re-prices these to the current effective price. Override rows are
  // excluded — regenerating would DISCARD the operator's deliberate box edit.
  let atCurrent = 0;
  let atOld = 0;
  let oldSumDelta = 0; // sum over stale rows of (effective - existing)
  for (const r of generatedRows) {
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
  console.log(`Generated rows at a DIFFERENT (old) price        : ${atOld}` +
    `${overrideCount > 0 ? `  (+${overrideCount} manual override(s) excluded)` : ''}`);
  console.log(
    `Expected box-cost delta if regenerated          : ${money(oldSumDelta)}` +
      ` (over ${atOld} stale generated row${atOld === 1 ? '' : 's'})`
  );
  if (atOld > 0 && effectivePrice !== null) {
    console.log(
      `  -> regenerating re-prices ${atOld} generated row(s) to ${money(effectivePrice)} each.`
    );
  }
  line();

  // ── 4. Summary cache vs live detail consistency — PER WINDOW ──────────────
  // billing_summary_metrics is keyed (client_id, period_from, period_to) and the
  // app reads exactly ONE window at a time (getFreshBillingSummaryMetrics matches
  // period_from/period_to + a 45-min read TTL). Consistency must therefore be
  // checked PER WINDOW: each cached package_total vs the live SUM(total_cost) of
  // package_cost rows whose ship_date falls in that window's day range. Summing
  // package_total across windows is meaningless — windows overlap, so the sum
  // always "mismatches" (this was the old diagnostic's false alarm).
  //
  // The cache stores period_from/period_to at day granularity, so we reconstruct
  // the window as [period_from 00:00, period_to+1day) — exact for day-aligned
  // ranges (the norm). Override rows are included on BOTH sides (the cache sums
  // every package_cost row, override or not), so they never create a delta here.
  const windowRows = await sql<
    {
      period_from: string;
      period_to: string;
      cached: string;
      live: string;
      age_min: string;
    }[]
  >`
    select
      m.period_from::text as period_from,
      m.period_to::text   as period_to,
      m.package_total::text as cached,
      coalesce((
        select sum(b.total_cost)
        from billing_line_items b
        where b.client_id = ${clientId}
          and b.line_type = 'package_cost'
          and b.ship_date >= m.period_from::timestamptz
          and b.ship_date <  ((m.period_to::date + 1))::timestamptz
      ), 0)::text as live,
      (extract(epoch from (now() - m.updated_at)) / 60.0)::numeric(12,1)::text as age_min
    from billing_summary_metrics m
    where m.client_id = ${clientId}
    order by m.period_from, m.period_to
  `;

  if (windowRows.length === 0) {
    console.log('Summary cache: no cached windows for this client (rebuilds on next view).');
  } else {
    console.log(`Summary cache windows for client ${clientId} (cached vs live detail, per window):`);
    console.log('  period_from  period_to    cached       live         age(min)  status');
    let freshMismatch = false;
    let anyFresh = false;
    for (const w of windowRows) {
      const cached = n(w.cached);
      const live = n(w.live);
      const ageMin = n(w.age_min);
      const fresh = ageMin <= 45; // only fresh windows are actually served on read
      if (fresh) anyFresh = true;
      const mism = Math.abs(cached - live) > EPS;
      if (mism && fresh) freshMismatch = true;
      const status = !mism ? 'OK' : fresh ? 'MISMATCH (served!)' : 'stale (rebuilds on read)';
      console.log(
        `  ${w.period_from.padEnd(12)} ${w.period_to.padEnd(12)} ` +
          `${money(cached).padEnd(12)} ${money(live).padEnd(12)} ${String(ageMin).padEnd(9)} ${status}`
      );
    }
    console.log(
      `Per-window consistency                   : ${
        freshMismatch
          ? 'FRESH-WINDOW MISMATCH — investigate'
          : anyFresh
            ? 'all fresh (served) windows OK'
            : 'no fresh windows — all rebuild on read'
      }`
    );
    console.log(
      '  NOTE: day-range reconstruction assumes day-aligned windows; a window whose'
    );
    console.log(
      '  original range ended mid-day can show a benign near-boundary delta.'
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
