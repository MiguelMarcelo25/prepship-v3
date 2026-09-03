// PS-520 — mutation harness for the real-PostgreSQL invoice proof, COMMITTED so the claims in
// its history are reproducible from the repository alone. Review classified an uncommitted
// mutation report as PLAUSIBLE rather than CONFIRMED, which is the right call.
//
// Each mutation must be PROVEN APPLIED (an anchor that no longer matches is a hard failure —
// a mutation that silently did not apply looks exactly like a guard that caught it), must turn
// the proof RED — or, for a mutation the CSV guard owns, that guard — and is restored from the
// in-memory original and verified byte-identical. Never `git checkout`: that once wiped an
// uncommitted route in billing.ts.
//
// Needs PS520_PG17_ADMIN_URL like the proof itself. Each run is a full migration + seed +
// three routes + finalization (~60-90s), so this is a local/pre-push tool, not a CI step.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BILLING = 'src/routes/billing.ts';
const DAY = 'src/lib/time/billing-day.ts';
const CSV = 'src/routes/billing-invoice-csv.ts';
const TOTALS = 'src/services/billing-invoice-totals.ts';
const PROOF = 'npm run -s test:ps-520-invoice-routes-pg17';
const CSV_GUARD = 'npm run -s test:ps-468-invoice-csv';
const YML = '.github/workflows/render-auto-deploy.yml';
const DEPLOY_GUARD = 'npm run -s test:ps-520-render-deploy-pin';
const LEAF = 'src/services/billing-return-line-types.ts';
const LEAF_GUARD = 'npm run -s test:ps-521-return-vocabulary-leaf';

/** Replace the Nth (1-based) occurrence, or return null if it does not exist. */
function replaceNth(src, from, to, n) {
  let idx = -1;
  for (let i = 0; i < n; i += 1) {
    idx = src.indexOf(from, idx + 1);
    if (idx < 0) return null;
  }
  return src.slice(0, idx) + to + src.slice(idx + from.length);
}

// `checks` lists what must catch the mutation. The proof is always run; a mutation the CSV
// guard owns (the sanitizer's character class, a per-cell bypass) also runs that guard, and
// the mutation is killed if ANY listed check goes red. Naming the owner keeps the harness
// honest about WHICH gate protects what — a kill by the wrong check is still a kill, but a
// survivor is reported against the check that should have owned it.
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
  // Review's third-round defeats. A never-charged replacement fee rendered as numeric 0 survived
  // because the comparator folded blank and zero together for every money column; a wrong
  // adjustment Destination survived because the August document was checked by a two-column
  // parser instead of the 19-column comparator. The first is the UNCONDITIONAL form — what a
  // real revert of the PS-513 null looks like — not one keyed to the proof's own order number.
  { name: 'REVIEW — XLSX renders a never-charged replacement fee as 0 (every row)', file: BILLING,
    apply: (s) => replaceNth(s, 'replacePostage: replacePostageAmt > 0 ? replacePostageAmt : null,', 'replacePostage: replacePostageAmt > 0 ? replacePostageAmt : 0,', 1) },
  { name: 'REVIEW — XLSX adjustment row carries a wrong Destination', file: BILLING,
    apply: (s) => replaceNth(s, "destination: d.billing_adjustment_id ? '' : d.destination,", "destination: d.billing_adjustment_id ? 'WRONG DESTINATION' : d.destination,", 1) },
  // The r5 pre-audit's survivors (2026-09-02). Each survived 86 green checks for a reason the
  // proof now names: August was agreement-only (no absence, no exact count, no footing, no
  // totals interval), the day and Item Name were compared but never asserted to a VALUE, the
  // workbook's cell TYPES were never read, three scope shapes were never exercised, the
  // refusal check pinned a stale figure, and two text columns were blank in every fixture row.
  { name: 'PRE-AUDIT — lower bound one day too early: August re-bills the finalized July-31 order', file: BILLING,
    apply: (s) => replaceNth(s, '      and ${invoiceEffectiveDay} >= ${dateFrom}::timestamptz', "      and ${invoiceEffectiveDay} >= ${dateFrom}::timestamptz - interval '1 day'", 1) },
  { name: 'PRE-AUDIT — the billed day shifted by one in the invoice SQL', file: BILLING,
    apply: (s) => replaceNth(s, "to_char(${invoiceEffectiveDay} at time zone 'UTC', 'YYYY-MM-DD') as billing_effective_date,", "to_char((${invoiceEffectiveDay} + interval '1 day') at time zone 'UTC', 'YYYY-MM-DD') as billing_effective_date,", 1) },
  { name: 'PRE-AUDIT — XLSX Total written as a TEXT cell (SUM scores it 0)', file: BILLING,
    apply: (s) => replaceNth(s, 'fulfillmentFee: fulfillmentFeeAmt,', 'fulfillmentFee: fulfillmentFeeAmt.toFixed(2),', 1) },
  { name: 'PRE-AUDIT — csvField bypassed for the two appended columns (Carrier, Item Name)', file: CSV, checks: [CSV_GUARD],
    apply: (s) => replaceNth(s, "  return cells.map(csvField).join(',');", "  return cells.map((v, i) => (i >= 17 ? String(v ?? '') : csvField(v))).join(',');", 1) },
  { name: 'PRE-AUDIT — tab/CR dropped from the injection character class', file: CSV, checks: [CSV_GUARD],
    apply: (s) => replaceNth(s, "if (!strictSignedDecimal && /^[=+\\-@\\t\\r]/.test(s)) s = `'${s}`;", "if (!strictSignedDecimal && /^[=+\\-@]/.test(s)) s = `'${s}`;", 1) },
  { name: 'PRE-AUDIT — store-scoped callers read every client (storeIds branch = true)', file: BILLING,
    apply: (s) => replaceNth(s, 'predicates.push(sql`${clients.storeIds} && ${intArraySql(storeIds)}`);', 'predicates.push(sql`true`);', 1) },
  { name: 'PRE-AUDIT — a restricted caller with NO ids fails open', file: BILLING,
    apply: (s) => replaceNth(s, 'return scope.isRestricted ? sql`false` : sql`true`;', 'return sql`true`;', 1) },
  { name: 'PRE-AUDIT — the CSV refusal leaks the real grand total in its 404 body', file: BILLING,
    apply: (s) => replaceNth(s, "if (!data) return c.text('Client not found', 404);",
      "if (!data) { const leak = await billingInvoiceHeaderTotals(clientId, range.fromUtc, range.toUtcExclusive, db, await loadDuplicateOrderDecisions(clientId, range.fromUtc, range.toUtcExclusive)); return c.text(`Client not found (${leak.grandTotal})`, 404); }", 3) },
  { name: 'PRE-AUDIT — the adjustment row\'s Item Name (credit reason) blanked in the shared owner', file: BILLING,
    apply: (s) => replaceNth(s, '      item_names: r.adjustment_description ?? itemSummary.itemNames,', '      item_names: itemSummary.itemNames,', 1) },
  { name: 'PRE-AUDIT — canonical grand total clipped at zero (credits vanish from the headline)', file: TOTALS,
    apply: (s) => replaceNth(s, 'coalesce(sum(${invoiceAmount}), 0)::text as grand_total', 'coalesce(sum(greatest(${invoiceAmount}, 0)), 0)::text as grand_total', 1) },
  { name: 'PRE-AUDIT — XLSX totals-row range drops the adjustment row', file: BILLING,
    apply: (s) => replaceNth(s, '    const last = first + details.length - 1;', '    const last = first + details.length - 1 - (details.some((d) => d.billing_adjustment_id) ? 1 : 0);', 1) },
  { name: 'PRE-AUDIT — HTML prints a credit as $-12.34 again', file: BILLING,
    apply: (s) => replaceNth(s, "    return v <= -0.005 ? `-$${abs}` : `$${abs}`;", '    return `$${v.toFixed(2)}`;', 1) },
  // The r6.2 audit's survivors. The scope predicate's OR became AND with every gate green —
  // no principal carried both claims, so a false denial had nothing to fail against. Removing
  // commitId from the deploy workflow passed every guard — the runtime readback fires only after
  // Render has been asked to build, so the static pin is the guard that must die. Forcing every
  // Destination to 'Domestic' agreed across all three formats (PS-490 catches the route bypass;
  // this proof now asserts the value too).
  { name: 'AUDIT — client OR store scope becomes client AND store (false denial for combined claims)', file: BILLING,
    apply: (s) => replaceNth(s, 'return sql`(${sql.join(predicates, sql` or `)})`;', 'return sql`(${sql.join(predicates, sql` and `)})`;', 1) },
  { name: 'AUDIT — commitId removed from the Render deploy trigger (branch tip would deploy again)', file: YML, checks: [DEPLOY_GUARD],
    apply: (s) => replaceNth(s, ',\\"commitId\\":\\"${GITHUB_SHA}\\"', '', 1) },
  { name: 'AUDIT — every Destination forced to Domestic (a no-country order must say Needs Review)', file: BILLING,
    apply: (s) => replaceNth(s, '      destination: classifyDestinationCountry(r.ship_to_country).destination,', "      destination: 'Domestic',", 1) },
  // PS-521 r2 (Hermes 88%): the aggregate's ORDER is contractual and was unenforced — reversing it
  // left the whole pack green. The proof cannot see this (same members); the leaf guard owns it.
  { name: 'PS-521 — the return vocabulary aggregate reversed (order is the SQL in-list + portal contract)', file: LEAF, checks: [LEAF_GUARD],
    apply: (s) => replaceNth(s, "export const BILLING_RETURN_LINE_TYPES = [\n  'return',\n  'return_label',\n  'return_processing',\n  'return_postage',\n  'return_processing_fee',\n] as const;",
      "export const BILLING_RETURN_LINE_TYPES = [\n  'return_processing_fee',\n  'return_postage',\n  'return_processing',\n  'return_label',\n  'return',\n] as const;", 1) },
];

if (!process.env.PS520_PG17_ADMIN_URL && !process.env.PS502_PG17_ADMIN_URL && !process.env.PS488_PG17_ADMIN_URL) {
  console.error('FAIL: set PS520_PG17_ADMIN_URL to a DISPOSABLE PostgreSQL 17 (same as the proof).');
  process.exit(1);
}

// ── The tree must never be left mutated ─────────────────────────────────────────────────────
//
// On 2026-09-02 a run crashed INSIDE the restore write (Windows errno -4094, something held the
// file for an instant) and billing.ts stayed mutated on disk with the process gone. The pre-
// audit then showed two more ways to the same state: the ECONNREFUSED abort ran process.exit
// before the restore, and a Ctrl-C during the 60-90s child proof killed the parent from the
// default signal handler with nothing restored. A harness that can leave the tree mutated is
// worse than no harness — the next run "passes" against mutated code.
//
// So: the original of the file currently mutated is held in `pending`, and it is restored on
// EVERY exit path — normal, abort, uncaught, SIGINT, SIGTERM — with retries and a sidecar of
// last resort. The abort paths restore FIRST and exit second.
let pending = null;

function restoreOriginal(file, original) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      writeFileSync(file, original);
      if (readFileSync(file, 'utf8') === original) return true;
    } catch (e) {
      console.error(`  restore attempt ${attempt} for ${file}: ${e.code ?? e.message}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * attempt);
  }
  const sidecar = `${file}.ps520-restore`;
  try {
    writeFileSync(sidecar, original);
    console.error(`RESTORE FAILED for ${file} after 8 attempts — the ORIGINAL is at ${sidecar}; copy it back before anything else`);
  } catch (e) {
    console.error(`RESTORE FAILED for ${file} and the sidecar write failed too (${e.code ?? e.message}); the original is ${original.length} bytes and is lost with this process — git diff the file NOW`);
  }
  return false;
}

function restorePending() {
  if (!pending) return true;
  const { file, original } = pending;
  pending = null;
  return restoreOriginal(file, original);
}

process.on('exit', () => { restorePending(); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { console.error(`\n${signal} — restoring the mutated file before exiting`); restorePending(); process.exit(130); });
}
process.on('uncaughtException', (e) => { console.error('uncaught:', e); restorePending(); process.exit(1); });

const INFRA = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|ENOBUFS|55006|being accessed by other users|could not connect|server closed the connection|Connection terminated/;

/** 'green' | 'red' | 'infra' — an infrastructure failure is NOT a kill and NOT a survival. */
function outcome(cmd) {
  try { execSync(cmd, { stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }); return 'green'; }
  catch (e) {
    // A child killed by the operator's Ctrl-C is neither red nor green. This loop is synchronous,
    // so the SIGINT handler above cannot pre-empt it: restore here and leave, or the interrupted
    // mutation would be scored as a kill and the run would continue to PASS.
    if (e.signal === 'SIGINT' || e.signal === 'SIGTERM' || e.signal === 'SIGHUP') {
      console.error(`\n${e.signal} during "${cmd}" — restoring and exiting`); restorePending(); process.exit(130);
    }
    const out = String(e.stdout ?? '') + String(e.stderr ?? '') + String(e.code ?? '') + String(e.signal ?? '');
    return INFRA.test(out) ? 'infra' : 'red';
  }
}

function abortInfra(where) {
  console.error(`   !! infrastructure failure during ${where} (DB down / timeout) — result meaningless; restoring and aborting`);
  restorePending();
  process.exit(1);
}

// Fail fast: every anchor must match the CURRENT tree before anything runs. A stale anchor
// would otherwise surface only after minutes of proof runs, and a partially-run matrix is
// easy to misreport.
const stale = MUTATIONS.filter((m) => { const src = readFileSync(m.file, 'utf8'); const out = m.apply(src); return out === null || out === src; });
if (stale.length) {
  console.error('ABORT — these mutations no longer anchor to the tree (fix the anchor, do not delete the mutation):');
  for (const m of stale) console.error(`  ${m.name}  [${m.file}]`);
  process.exit(1);
}

// PS520_MUTATIONS_ONLY=<regex> re-runs a subset after a targeted repair (each mutation is a
// full proof run, so the whole matrix is ~40 minutes). A subset run says so in its output and
// never prints the full-matrix PASS line, so it cannot be mistaken for one.
const only = process.env.PS520_MUTATIONS_ONLY ? new RegExp(process.env.PS520_MUTATIONS_ONLY, 'i') : null;
const SELECTED = only ? MUTATIONS.filter((m) => only.test(m.name)) : MUTATIONS;
if (only) console.log(`SUBSET RUN: ${SELECTED.length}/${MUTATIONS.length} mutations match /${only.source}/i`);
if (!SELECTED.length) { console.error('no mutation matches PS520_MUTATIONS_ONLY'); process.exit(1); }

// Every check a selected mutation relies on must be GREEN on the unmutated tree, not only the
// proof: a guard that is red for an unrelated reason would report "killed [ps-468]" while
// proving nothing.
for (const cmd of [PROOF, ...new Set(SELECTED.flatMap((m) => m.checks ?? []))]) {
  const base = outcome(cmd);
  if (base === 'infra') abortInfra(`the baseline of "${cmd}"`);
  if (base === 'red') { console.error(`ABORT — "${cmd}" is RED before any mutation. Fix the baseline first.`); process.exit(1); }
  console.log(`baseline: "${cmd}" green on the unmutated tree`);
}

let survived = 0;
for (const m of SELECTED) {
  const original = readFileSync(m.file, 'utf8');
  const mutated = m.apply(original);
  pending = { file: m.file, original };
  writeFileSync(m.file, mutated);
  const checks = [PROOF, ...(m.checks ?? [])];
  const results = checks.map((c) => outcome(c));
  if (!restorePending()) process.exit(1);
  if (results.includes('infra')) abortInfra(m.name);
  const killedBy = checks.filter((_, i) => results[i] === 'red').map((c) => (c === PROOF ? 'proof' : c === CSV_GUARD ? 'ps-468' : c === LEAF_GUARD ? 'ps-521' : 'deploy-pin'));
  if (killedBy.length === 0) { survived += 1; console.error(`  SURVIVED     ${m.name}`); }
  else console.log(`  killed       ${m.name}  [${killedBy.join('+')}]`);
}
console.log(`\n${SELECTED.length - survived}/${SELECTED.length} mutations killed${only ? ' (SUBSET)' : ''}`);
if (survived) { console.error('\n✖ PS-520 mutation harness FAILED'); process.exit(1); }
console.log(only ? '\nsubset green — this is NOT a full-matrix result' : '\nPASS PS-520 mutations — every mutation dies against real PostgreSQL, restore verified');
