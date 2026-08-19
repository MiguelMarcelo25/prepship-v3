import { readFileSync } from 'node:fs';
import {
  classifyCustomerShippingMoney,
  mayUseLegacyRecompute,
  billableUnder,
} from '../src/services/customer-shipping-money-classification';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
} from '../src/services/customer-shipping-money-snapshot';
import {
  buildCoverageReport,
  outboundCoveragePct,
  type CoverageRow,
} from '../src/services/customer-shipping-money-coverage';

/**
 * PS-508 step 1 — the five-state classifier.
 *
 * The plan review ruled the cutover unsafe while "no billable tuple" collapsed four different
 * situations into one null. These checks execute the distinction. Pure: no database, no env, so
 * it runs in every lane.
 */

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`ok   ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const money = {
  selectedRateCost: 10,
  cShippingRateAmount: 12,
  shippingMarginAmount: 2,
  shippingMarginPct: 16.7,
  rateCostSource: 'label_final_cost',
  customerRateSource: 'realized_customer_shipping_rate',
};
const v437 = { ...money, customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION };
const v508 = {
  ...money,
  customerRateSource: 'house_next_best_customer_rate',
  billingDescriptionSuffix: '',
  customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
};

check('valid ps-437-v1 classifies as valid_ps437',
  classifyCustomerShippingMoney(v437).kind === 'valid_ps437');
check('valid ps-508-v1 classifies as valid_ps508',
  classifyCustomerShippingMoney(v508).kind === 'valid_ps508');

// The ordinary pre-writer shape: a real provider receipt, no tuple. This is the ONLY state that
// may recompute after cutover, so misclassifying it strands every historical shipment.
const receiptOnly = { carrierCode: 'ups', cost: 10, totalCost: 10, providerLabelId: 'x' };
check('a receipt with no version key is legacy_absent (not malformed)',
  classifyCustomerShippingMoney(receiptOnly).kind === 'legacy_absent');
check('null / non-object selected_rate_json is legacy_absent',
  classifyCustomerShippingMoney(null).kind === 'legacy_absent'
  && classifyCustomerShippingMoney([1, 2]).kind === 'legacy_absent');

// A row WE wrote and got wrong. Recomputing it silently would hide a writer defect behind the
// legacy path, and the one-shot guard keys on key presence so the writer will not repair it.
{
  const c = classifyCustomerShippingMoney({ ...v437, shippingMarginAmount: 5 });
  check('a known version whose margin does not reconcile is malformed_known_version',
    c.kind === 'malformed_known_version', JSON.stringify(c));
  check('and it reports WHY, for the operator report',
    c.kind === 'malformed_known_version' && /margin does not reconcile/.test(c.reason),
    c.kind === 'malformed_known_version' ? c.reason : c.kind);
}
{
  const partial = { ...v437 } as Record<string, unknown>;
  delete partial.cShippingRateAmount;
  const c = classifyCustomerShippingMoney(partial);
  check('a known version missing a money field is malformed, and names the field',
    c.kind === 'malformed_known_version' && /cShippingRateAmount/.test(c.reason),
    JSON.stringify(c));
}

// A FUTURE policy this build cannot read. Never repaired, never overwritten.
{
  const c = classifyCustomerShippingMoney({ ...money, customerShippingMoneyPolicyVersion: 'ps-999-v9' });
  check('an unrecognised version is unknown_version, carrying the raw value',
    c.kind === 'unknown_version' && c.rawVersion === 'ps-999-v9', JSON.stringify(c));
}
check('a non-string version key is unknown_version, never legacy_absent',
  classifyCustomerShippingMoney({ ...money, customerShippingMoneyPolicyVersion: 42 }).kind
    === 'unknown_version');

// THE cutover safety property. If any of the three non-legacy failures could recompute, a
// systematic writer error would bill as though it were an ordinary historical row.
check('ONLY legacy_absent may take the recompute fallback',
  mayUseLegacyRecompute(classifyCustomerShippingMoney(receiptOnly))
  && !mayUseLegacyRecompute(classifyCustomerShippingMoney({ ...v437, shippingMarginAmount: 5 }))
  && !mayUseLegacyRecompute(classifyCustomerShippingMoney({ ...money, customerShippingMoneyPolicyVersion: 'ps-999-v9' }))
  && !mayUseLegacyRecompute(classifyCustomerShippingMoney(v508))
  && !mayUseLegacyRecompute(classifyCustomerShippingMoney(v437)));

// Staging still holds at the classifier layer: a v2 tuple is classified, but not yet billable to
// a consumer that has only opted into v1.
check('STAGING: valid_ps508 is NOT billable to a v1-only consumer',
  billableUnder(classifyCustomerShippingMoney(v508), [CUSTOMER_SHIPPING_MONEY_POLICY_VERSION]) === null);
check('valid_ps508 IS billable to a consumer that accepts it',
  billableUnder(classifyCustomerShippingMoney(v508), ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS)
    ?.cShippingRateAmount === 12);
check('a malformed tuple is never billable, under any accept list',
  billableUnder(classifyCustomerShippingMoney({ ...v437, shippingMarginAmount: 5 }),
    ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS) === null);

// Purity: the audit, the billing precedence path and CI all need this in lanes with no database.
const src = readFileSync('src/services/customer-shipping-money-classification.ts', 'utf8');
check('the classifier never value-imports db/client',
  !/^\s*import\s+(?!type\b)[^;]*['"][^'"]*db\/client/m.test(src)
  && !/from '\.\/customer-shipping-money\.js'/.test(src));


// ── COVERAGE REPORT (behavioural, offline) ────────────────────────────────────────────────

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const row = (over: Partial<CoverageRow> = {}): CoverageRow => ({
  shipmentId: 1, clientId: 1, source: 'prepship_v2', excluded: null, createdAt: null,
  kind: 'valid_ps508', tupleAmount: 12, recomputeAmount: 12, ...over,
});

// Excluded rows are CORRECTLY without an outbound tuple. Folding them into "no tuple" inflates the
// gap and would be used to justify a backfill over rows that must never receive one.
{
  const r = buildCoverageReport([
    row({ shipmentId: 1, excluded: 'return' }),
    row({ shipmentId: 2, excluded: 'replacement' }),
    row({ shipmentId: 3, excluded: 'voided' }),
    row({ shipmentId: 4, excluded: 'test_offline' }),
    row({ shipmentId: 5, excluded: 'no_billable_cost' }),
    row({ shipmentId: 6, kind: 'valid_ps508' }),
  ]);
  check('excluded rows are counted by reason and kept OUT of the in-scope population',
    r.excludedTotal === 5 && r.inScope === 1 && r.excluded.return === 1
    && r.excluded.no_billable_cost === 1, JSON.stringify({ ex: r.excludedTotal, io: r.inScope }));
  check('an excluded row never lands in a classification bucket',
    Object.values(r.byKind).reduce((a, b) => a + b, 0) === 1);
  check('coverage is measured against IN-SCOPE rows, not the total',
    outboundCoveragePct(r) === 100, String(outboundCoveragePct(r)));
}

// THE trap for a bill-and-log policy: opposite-signed deltas cancel. A signed total of zero can
// hide real per-line divergence, so absolute is reported alongside it and never derived from it.
{
  const r = buildCoverageReport([
    row({ shipmentId: 1, tupleAmount: 13, recomputeAmount: 12 }),
    row({ shipmentId: 2, tupleAmount: 11, recomputeAmount: 12 }),
  ]);
  check('offsetting deltas cancel in the SIGNED total but not the ABSOLUTE total',
    r.signedDollars === 0 && r.absoluteDollars === 2 && r.differing === 2,
    JSON.stringify({ s: r.signedDollars, a: r.absoluteDollars, d: r.differing }));
  check('the largest single delta is reported with its shipment',
    r.maxAbsoluteDelta?.shipmentId === 1 && r.maxAbsoluteDelta?.delta === 1);
}

// Float noise must not read as a money difference.
check('comparison is cent-safe (12.00 vs 11.999999 is not a divergence)',
  buildCoverageReport([row({ tupleAmount: 12, recomputeAmount: 11.999999 })]).differing === 0);

// These are stop conditions, not statistics.
{
  const r = buildCoverageReport([
    row({ shipmentId: 1, kind: 'malformed_known_version', tupleAmount: null }),
    row({ shipmentId: 2, kind: 'unknown_version', tupleAmount: null }),
  ]);
  check('malformed and unknown rows each raise an ACTIVATION BLOCKER',
    r.activationBlockers.length === 2
    && r.activationBlockers.some((b) => /malformed_known_version/.test(b))
    && r.activationBlockers.some((b) => /unknown_version/.test(b)),
    JSON.stringify(r.activationBlockers));
}

// A tuple billing cannot reproduce is unmeasurable divergence, not zero divergence.
{
  const r = buildCoverageReport([row({ tupleAmount: 12, recomputeAmount: null })]);
  check('a valid tuple with no comparable recompute is uncomparable AND blocks activation',
    r.uncomparable === 1 && r.compared === 0
    && r.activationBlockers.some((b) => /unmeasurable, not zero/.test(b)),
    JSON.stringify(r));
}

check('a clean population raises NO activation blockers',
  buildCoverageReport([row(), row({ shipmentId: 2 })]).activationBlockers.length === 0);

// legacy_absent is in scope (it is a real gap) but has no tuple to compare.
{
  const r = buildCoverageReport([row({ kind: 'legacy_absent', tupleAmount: null, recomputeAmount: 12 })]);
  check('legacy_absent counts as an in-scope coverage gap, not a comparison or a blocker',
    r.inScope === 1 && r.byKind.legacy_absent === 1 && r.compared === 0
    && r.activationBlockers.length === 0 && outboundCoveragePct(r) === 0);
}

// ── THE AUDIT IS READ-ONLY ────────────────────────────────────────────────────────────────

const auditSrc = stripComments(readFileSync('scripts/ps-508-coverage-audit.ts', 'utf8'));
check('the coverage audit issues no write of any kind',
  !/\b(insert\s+into|update\s+[a-z_]+\s+set|delete\s+from|truncate|drop\s+table|alter\s+table)/i.test(auditSrc)
  && !/\.insert\(|\.update\(|\.delete\(/.test(auditSrc));
check('the coverage audit recomputes through the canonical preview, not a private copy',
  /previewShipmentCustomerShippingMoney\(/.test(auditSrc)
  && !/resolveCustomerShippingMoney\(\{/.test(auditSrc));
check('the coverage audit refuses to run without a named operator',
  /PS508_AUDIT_OPERATOR/.test(auditSrc) && /process\.exit\(2\)/.test(auditSrc));

// The gate must be REACHED, not merely present. A top-level `import { db } from db/client`
// validates the database env at module load, so the process dies with "Invalid environment
// variables" before the refusal ever runs — the gate exists and never fires. Found by executing it.
check('the operator gate is reachable: db/client is imported dynamically, after the gate',
  !/^import\s+\{[^}]*\bdb\b[^}]*\}\s+from\s+'[^']*db\/client'/m.test(auditSrc)
  && /await import\('\.\.\/src\/db\/client'\)/.test(auditSrc));
check('and the money service is likewise deferred past the gate',
  !/^import\s+\{[^}]*previewShipmentCustomerShippingMoney/m.test(auditSrc)
  && /await import\('\.\.\/src\/services\/customer-shipping-money'\)/.test(auditSrc));

// ── THE AUDIT RUNS ON RENDER, NOT ON A WORKSTATION ────────────────────────────────────────

// Running it locally means a production database credential lives on a workstation, where it can
// leak and must be rotated. The Render one-off job runs inside the environment that already holds
// one. This is the repo's established pattern (BILL-DUP-OUTBOUND-CHARGE), not a new invention.
const laneSrc = readFileSync('.github/workflows/render-one-off-ps-508-coverage-audit.yml', 'utf8');

check('a Render one-off lane exists and dispatches the audit script',
  /workflow_dispatch/.test(laneSrc)
  && /scripts\/ps-508-coverage-audit\.ts/.test(laneSrc)
  && /api\.render\.com\/v1\/services/.test(laneSrc));

// An env var is whatever its setter types. github.actor is authenticated and cannot be forged by
// the person dispatching, which is what makes the lane — not the env var — the real operator gate.
check('the lane supplies the operator from the AUTHENTICATED actor, not a hand-set value',
  /PS508_AUDIT_OPERATOR='\$\{AUDIT_OPERATOR\}'/.test(laneSrc)
  && /AUDIT_OPERATOR:\s*\$\{\{\s*github\.actor\s*\}\}/.test(laneSrc));

// The lane must refuse to dispatch a script that has grown a write, and must require the
// server-side read-only pin. Checking the lane still CONTAINS those gates, because deleting them
// would be silent — the lane would go green while proving nothing.
check('the lane refuses to dispatch a script containing a write statement',
  /A write-shaped statement appeared in the audit script/.test(laneSrc));
check('the lane requires the session READ ONLY pin before dispatching',
  /The audit must pin the session READ ONLY/.test(laneSrc));
check('the audit pins the session READ ONLY at the server',
  /SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY/.test(auditSrc));

// No confirmation token and no apply mode: a token gates a write, and this lane has none. The
// historical backfill is a separate, evidence-qualified job — bolting it on here would let an
// approved read become an unapproved write.
// Tested against COMMENT-STRIPPED yaml. The lane's own header says "there is no --apply", so an
// un-stripped negative assertion fails on the prose explaining the very thing it asserts — the
// same false positive that hit four checks in PS-502.
const laneCode = laneSrc.replace(/^\s*#.*$/gm, '');
check('the lane has no apply/repair mode and no write token',
  !/--apply|confirm[_-]?token|CONFIRM=/i.test(laneCode));


// ── THE REPORT COMES BACK TO WHERE THE RUN WAS TRIGGERED ──────────────────────────────────

// The lane's first dispatch succeeded and still left the numbers only in Render's log: green, and
// practically useless. Retrieval brings them into the Actions log.
check('the lane retrieves the Render job log into the run',
  /Retrieve the Render job log into this run/.test(laneSrc)
  && /api\.render\.com\/v1\/logs/.test(laneCode));

// THE safety property. The audit exits NON-ZERO to report activation blockers — that is a result,
// not a malfunction — so retrieval must run even when the previous step failed, and must never
// change the verdict in either direction. A transcription step that can turn a failing audit green
// is worse than no transcription at all.
check('retrieval runs even when the audit step failed, and cannot alter the verdict',
  /if: always\(\) && env\.RENDER_JOB_ID != ''/.test(laneCode)
  && /continue-on-error: true/.test(laneCode));

// The job id is exported before polling, so a blocker-reporting (non-zero) run still has an id to
// fetch by. Exporting it only on success would lose the log exactly when it matters most.
check('the job id is exported to the environment before the poll loop can fail',
  laneCode.indexOf('RENDER_JOB_ID=${job_id}') < laneCode.indexOf('for attempt in $(seq'));

// Every failure path must leave something actionable rather than a silent blank.
check('an unresolvable log fetch still prints the job id and where to read it',
  /Could not transcribe the Render log automatically/.test(laneCode)
  && /Jobs -> \$\{RENDER_JOB_ID\} -> Logs/.test(laneCode));

// ── THE WATERMARK SPLIT ───────────────────────────────────────────────────────────────────

// The first production run returned 100% legacy_absent over 32 rows. That number is unreadable on
// its own: "nothing shipped since the writer deployed" and "the writer is live and not firing"
// produce exactly the same figure, and they are opposite conclusions. These checks are the reason
// the split exists.
const WM = '2026-08-19T02:23:00Z';
const dated = (createdAt: string, over: Partial<CoverageRow> = {}): CoverageRow =>
  row({ createdAt, ...over });

// Before the writer existed: absent is history, and no amount of re-running changes it.
{
  const r = buildCoverageReport([
    dated('2026-08-18T10:00:00Z', { shipmentId: 1, kind: 'legacy_absent', tupleAmount: null }),
    dated('2026-08-18T11:00:00Z', { shipmentId: 2, kind: 'legacy_absent', tupleAmount: null }),
  ], WM);
  check('pre-watermark legacy_absent is history, NOT an activation blocker',
    r.preWatermark.rows === 2 && r.postWatermark.rows === 0
    && r.activationBlockers.length === 0, JSON.stringify(r.activationBlockers));
  check('and the report says plainly that nothing post-dates the watermark',
    r.postWatermark.rows === 0);
}

// After the writer deployed: absent means the freeze is live and not firing. THE finding the first
// run could not have surfaced.
{
  const r = buildCoverageReport([
    dated('2026-08-19T05:00:00Z', { shipmentId: 3, kind: 'legacy_absent', tupleAmount: null }),
    dated('2026-08-18T10:00:00Z', { shipmentId: 4, kind: 'legacy_absent', tupleAmount: null }),
  ], WM);
  check('post-watermark legacy_absent RAISES an activation blocker',
    r.activationBlockers.some((b) => /created AFTER the writer deployed/.test(b)),
    JSON.stringify(r.activationBlockers));
  check('the split counts each side separately',
    r.postWatermark.rows === 1 && r.preWatermark.rows === 1
    && r.postWatermark.byKind.legacy_absent === 1);
}

// A post-watermark row that DID freeze is the healthy case and must stay silent.
{
  const r = buildCoverageReport([
    dated('2026-08-19T05:00:00Z', { shipmentId: 5, kind: 'valid_ps508' }),
  ], WM);
  check('a post-watermark row carrying a tuple raises nothing',
    r.activationBlockers.length === 0 && r.postWatermark.byKind.valid_ps508 === 1);
}

// Without a watermark there is no split and no blocker — the report must not invent a verdict it
// cannot support.
{
  const r = buildCoverageReport([
    dated('2026-08-19T05:00:00Z', { kind: 'legacy_absent', tupleAmount: null }),
  ]);
  check('with NO watermark the report claims neither side and raises no blocker',
    r.watermark === null && r.postWatermark.rows === 0 && r.preWatermark.rows === 0
    && r.activationBlockers.length === 0);
}

// The window describes the whole sweep, excluded rows included — it reports what was looked at.
{
  const r = buildCoverageReport([
    dated('2026-08-17T09:00:00Z', { shipmentId: 1, excluded: 'return' }),
    dated('2026-08-19T06:00:00Z', { shipmentId: 2 }),
    dated('2026-08-18T12:00:00Z', { shipmentId: 3 }),
  ], WM);
  check('the population window spans every scanned row, excluded ones included',
    r.populationWindow.earliest === '2026-08-17T09:00:00Z'
    && r.populationWindow.latest === '2026-08-19T06:00:00Z',
    JSON.stringify(r.populationWindow));
}

// `excluded: 0` against a UI full of Ext. Label rows was unverifiable in the first run. The source
// breakdown covers every in-scope row so the claim can be checked instead of trusted.
{
  const r = buildCoverageReport([
    dated('2026-08-19T01:00:00Z', { shipmentId: 1, source: 'prepship_v2' }),
    dated('2026-08-19T02:00:00Z', { shipmentId: 2, source: 'prepship_v2' }),
    dated('2026-08-19T03:00:00Z', { shipmentId: 3, source: 'shipstation' }),
    dated('2026-08-19T04:00:00Z', { shipmentId: 4, excluded: 'return', source: 'x' }),
  ], WM);
  const bySource = Object.fromEntries(r.inScopeBySource.map((s) => [s.source, s.rows]));
  check('in-scope source breakdown counts every in-scope row and omits excluded ones',
    bySource.prepship_v2 === 2 && bySource.shipstation === 1 && bySource.x === undefined,
    JSON.stringify(r.inScopeBySource));
}
if (failures > 0) {
  console.log(`\nFAIL PS-508 classification guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPS-508 classification guard passed.');
