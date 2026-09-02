// PS-520 — mutation harness for the real-PostgreSQL invoice proof, COMMITTED so the claims in
// its history are reproducible from the repository alone. Review classified an uncommitted
// mutation report as PLAUSIBLE rather than CONFIRMED, which is the right call.
//
// Each mutation must be PROVEN APPLIED (an anchor that no longer matches is a hard failure —
// a mutation that silently did not apply looks exactly like a guard that caught it), must turn
// test:ps-520-invoice-routes-pg17 RED, and is restored from the in-memory original and verified
// byte-identical. Never `git checkout`: that once wiped an uncommitted route in billing.ts.
//
// Needs PS520_PG17_ADMIN_URL like the proof itself. Each run is a full migration + seed +
// three routes + finalization (~60-90s), so this is a local/pre-push tool, not a CI step.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BILLING = 'src/routes/billing.ts';
const DAY = 'src/lib/time/billing-day.ts';

/** Replace the Nth (1-based) occurrence, or return null if it does not exist. */
function replaceNth(src, from, to, n) {
  let idx = -1;
  for (let i = 0; i < n; i += 1) {
    idx = src.indexOf(from, idx + 1);
    if (idx < 0) return null;
  }
  return src.slice(0, idx) + to + src.slice(idx + from.length);
}

const MUTATIONS = [
  { name: 'XLSX Shipping cell 999.99 (review\'s original defeat)', file: BILLING,
    apply: (s) => replaceNth(s, 'const shippingAmt = Number(d.shipping_amt);', 'const shippingAmt = 999.99;', 2) },
  { name: 'operator HTML Shipping cell 999.99', file: BILLING,
    apply: (s) => replaceNth(s, 'const shippingAmt = Number(d.shipping_amt);', 'const shippingAmt = 999.99;', 1) },
  { name: 'PS-513 SQL-comment interpolation (the 6-hour outage)', file: BILLING,
    apply: (s) => { const m = /^(\s*)-- PS-519: the words detailAmount.*$/m.exec(s); return m ? s.replace(m[0], `${m[1]}-- PS-513 defect restored: \${detailAmount} keeps replacement money out of the base buckets.`) : null; } },
  { name: 'PS-491 duplicate suppression disabled on the invoice', file: BILLING,
    apply: (s) => replaceNth(s, 'const duplicateDecisions = await loadDuplicateOrderDecisions(clientId, dateFrom, dateTo);', 'const duplicateDecisions = new Map();', 1) },
  { name: 'cancelled-no-charge disabled (raw amount)', file: BILLING,
    apply: (s) => { const re = /const detailAmount = cancelledNoChargeBillingAmountSql\(\{[\s\S]*?\n  \}\);/; return re.test(s) ? s.replace(re, 'const detailAmount = sql`b.total_cost`;') : null; } },
  { name: 'period window one day too wide (exclusive bound = day+2)', file: DAY,
    apply: (s) => replaceNth(s, 'toUtcExclusive: `${nextDay(toDay)}T00:00:00.000Z`,', 'toUtcExclusive: `${nextDay(nextDay(toDay))}T00:00:00.000Z`,', 1) },
  // Review's second-round defeats. Both survived 65 green checks: the row comparison covered
  // only MONEY columns, and the formula check validated the column letters then discarded the
  // row digits. Header identity is not value identity, and "which column" is not "which rows".
  { name: 'REVIEW — XLSX Qty cell 999 (a non-money column nobody compared)', file: BILLING,
    apply: (s) => replaceNth(s, 'qty: baseQty + addlQty,', 'qty: 999,', 1) },
  { name: 'REVIEW — XLSX totals formulas skip the first detail row (first = 3)', file: BILLING,
    apply: (s) => replaceNth(s, 'const first = 2;', 'const first = 3;', 1) },
  // Review's third-round defeats. A never-charged replacement fee rendered as numeric 0 on the
  // cancelled row survived because the comparator folded blank and zero together for every
  // money column; a wrong adjustment Destination survived because the August document was
  // checked by a two-column parser instead of the 19-column comparator.
  { name: 'REVIEW — XLSX renders a never-charged replacement fee as 0 on the cancelled row', file: BILLING,
    apply: (s) => replaceNth(s, 'replacePostage: replacePostageAmt > 0 ? replacePostageAmt : null,',
      "replacePostage: replacePostageAmt > 0 ? replacePostageAmt : (d.order_number_label === 'PS520-CANCELLED' ? 0 : null),", 1) },
  { name: 'REVIEW — XLSX adjustment row carries a wrong Destination', file: BILLING,
    apply: (s) => replaceNth(s, "destination: d.billing_adjustment_id ? '' : d.destination,", "destination: d.billing_adjustment_id ? 'WRONG DESTINATION' : d.destination,", 1) },
];

if (!process.env.PS520_PG17_ADMIN_URL && !process.env.PS502_PG17_ADMIN_URL && !process.env.PS488_PG17_ADMIN_URL) {
  console.error('FAIL: set PS520_PG17_ADMIN_URL to a DISPOSABLE PostgreSQL 17 (same as the proof).');
  process.exit(1);
}

const proofIsGreen = () => {
  try { execSync('npm run -s test:ps-520-invoice-routes-pg17', { stdio: 'pipe' }); return true; }
  catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    if (/ECONNREFUSED/.test(out)) { console.error('   !! DB DOWN — result meaningless; aborting'); process.exit(1); }
    return false;
  }
};

/**
 * Restore the ORIGINAL bytes, retrying through Windows' transient file faults. On 2026-09-02 a
 * run crashed here with errno -4094 (UNKNOWN) on the restore write — something else held the
 * file for an instant — and billing.ts was left MUTATED on disk with the process gone. A
 * harness that can leave the tree mutated is worse than no harness. Retry with backoff; if it
 * still fails, write the original to a sidecar next to the file and say so, so the restore is
 * never lost.
 */
function restoreOriginal(file, original) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      writeFileSync(file, original);
      if (readFileSync(file, 'utf8') === original) return;
    } catch (e) {
      console.error(`  restore attempt ${attempt} for ${file}: ${e.code ?? e.message}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * attempt);
  }
  const sidecar = `${file}.ps520-restore`;
  writeFileSync(sidecar, original);
  console.error(`RESTORE FAILED for ${file} after 8 attempts — the ORIGINAL is at ${sidecar}; copy it back before anything else`);
  process.exit(1);
}

if (!proofIsGreen()) { console.error('ABORT — the proof is RED before any mutation. Fix the baseline first.'); process.exit(1); }
console.log('baseline: proof green on the unmutated tree');

let survived = 0, notApplied = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  const mutated = m.apply(original);
  if (mutated === null || mutated === original) { notApplied += 1; console.error(`  NOT APPLIED  ${m.name}`); continue; }
  writeFileSync(m.file, mutated);
  const green = proofIsGreen();
  restoreOriginal(m.file, original);
  if (green) { survived += 1; console.error(`  SURVIVED     ${m.name}`); } else console.log(`  killed       ${m.name}`);
}
console.log(`\n${MUTATIONS.length - survived - notApplied}/${MUTATIONS.length} mutations killed, ${notApplied} not applied`);
if (survived || notApplied) { console.error('\n✖ PS-520 mutation harness FAILED'); process.exit(1); }
console.log('\nPASS PS-520 mutations — every mutation dies against real PostgreSQL, restore verified');
