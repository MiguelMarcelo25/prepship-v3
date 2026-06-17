#!/usr/bin/env tsx
/**
 * PS-271 (Layer 4) — READ-ONLY cohort re-rate verification PROBE.
 *
 * Purpose (DJ-run only, never automated): for a small cohort of recently-quoted Shipp orders, READ the
 * persisted best rate + the cached/observed carrier set and report how many would now be flagged
 * thin/unproven by the Layer 4 honesty signal — i.e. quantify the #1502 "FedEx persisted when UPS was a
 * tick away" exposure WITHOUT re-quoting Shipp, flipping any env flag, or buying anything.
 *
 * SAFETY CONTRACT (this script is intentionally inert until DJ explicitly opts in):
 *   - REFUSES to run unless invoked with --confirm. Bare `tsx scripts/ps-271-cohort-rerate-verify.ts`
 *     prints the contract and exits 2 BEFORE importing the DB client or touching anything.
 *   - READ-ONLY: only SELECTs. Never UPDATE/DELETE/INSERT. Never calls a carrier/marketplace/label
 *     endpoint. Never re-rates Shipp live (no /quote POST). Never enables the per-account
 *     shippObservedSetRetry flag or DIRECT_CARRIER_RATE_CACHE.
 *   - This is the cohort PROBE the orchestrator was told to AUTHOR but NOT RUN. Running it is a
 *     deliberate, separately-approved DJ step ("test against Render, read-only").
 *
 *   tsx scripts/ps-271-cohort-rerate-verify.ts --confirm [--limit=20]
 */

// ── Refuse-by-default gate (runs BEFORE any DB/network import) ────────────────
const argv = process.argv.slice(2);
const confirmed = argv.includes('--confirm');
if (!confirmed) {
  console.error(
    [
      'PS-271 cohort re-rate verify PROBE — refused (no --confirm).',
      '',
      'This is a READ-ONLY probe and is INERT by default. It performs NO writes, NO live Shipp',
      're-quote, NO env-flag flips, NO postage/marketplace calls. It only SELECTs the persisted best',
      'rate + cached observed-carrier set for a small cohort and reports how many would now be flagged',
      'thin/unproven by the PS-271 Layer 4 honesty signal.',
      '',
      'To run it deliberately (DJ, read-only against the target DB):',
      '  tsx scripts/ps-271-cohort-rerate-verify.ts --confirm [--limit=20]',
    ].join('\n'),
  );
  process.exit(2);
}

const limitArg = argv.find((a) => a.startsWith('--limit='));
const cohortLimit = Math.max(1, Math.min(100, Number.parseInt(limitArg?.split('=')[1] ?? '20', 10) || 20));

async function main(): Promise<void> {
  // Imports are deferred INSIDE the confirmed branch so the refuse path never opens a DB connection.
  const [{ sql: pg }, observed] = await Promise.all([
    import('../src/db/client'),
    import('../src/connectors/carrier/shipp-observed-carriers'),
  ]);

  console.log(`\n=== PS-271 cohort re-rate verify (READ-ONLY, limit=${cohortLimit}) ===\n`);

  // READ-ONLY: recent awaiting orders whose persisted best rate is a Shipp pick. SELECT only.
  const rows = await pg<Array<{
    id: number;
    client_id: number | null;
    store_id: number | null;
    best_rate_json: unknown;
  }>>`
    SELECT o.id, o.client_id, o.store_id, oo.best_rate_json
    FROM orders o
    JOIN order_overrides oo ON oo.order_id = o.id
    WHERE o.order_status = 'awaiting_shipment'
      AND oo.best_rate_json IS NOT NULL
      AND oo.best_rate_json::text ILIKE '%shipp%'
    ORDER BY o.id DESC
    LIMIT ${cohortLimit}
  `;

  let thinCandidates = 0;
  for (const row of rows) {
    const best = (row.best_rate_json ?? {}) as Record<string, unknown>;
    const carrierCode = observed.normalizeObservedCarrier(best.carrier_code ?? best.carrierCode);
    // A best persisted as FedEx/UPS-only on a Shipp account is a candidate IF the durably-observed set
    // for that account/lane recently included a carrier the persisted best does NOT cover.
    const observedSet = await observed
      .readObservedCarriers({
        accountId: typeof best.directCarrierAccountId === 'number' ? best.directCarrierAccountId : null,
        sourceTable: typeof best.directCarrierSourceTable === 'string' ? best.directCarrierSourceTable : null,
        requestKey: typeof best.requestFingerprint === 'string' ? best.requestFingerprint : null,
        laneFingerprint: null,
      })
      .catch(() => [] as string[]);
    const missing = observed.missingObservedCarriers(observedSet, carrierCode ? [carrierCode] : []);
    if (missing.length) {
      thinCandidates += 1;
      console.log(`  order ${row.id}: persisted best=${carrierCode || '(unknown)'}, observed=${observedSet.join(',') || '(none)'} -> thin candidate (missing ${missing.join(',')})`);
    }
  }

  console.log('');
  console.log(`Cohort size:           ${rows.length}`);
  console.log(`Thin/unproven candidates: ${thinCandidates}`);
  console.log(`\nVERDICT: ${thinCandidates > 0
    ? `${thinCandidates} of ${rows.length} persisted Shipp bests would now be flagged thin/unproven.`
    : 'no thin/unproven persisted Shipp bests found in this cohort.'}`);
  console.log('(READ-ONLY probe — no rows were modified, no rates re-quoted, no flags flipped.)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('PS-271 cohort re-rate verify probe failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
