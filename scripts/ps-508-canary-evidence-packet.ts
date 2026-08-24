/**
 * PS-508 — the canary evidence packet. Schema version 2.
 *
 * v1 was REFUTED as an acceptance mechanism by the Hermes round-3 audit: it could report
 * zeroMismatch=HOLDS on zero rows, exited 0 on NOT-YET-COMPARED, self-validated legacy rows,
 * carried a handwritten Portal mirror weaker than the real predicate, used noncanonical cents,
 * could double-count a mismatching shipment, and its read-only flag was a string where the
 * postgres client expects a boolean — so server-side read-only was never proven. v2 closes
 * each of those by construction:
 *
 *  - READ-ONLY, PROVEN: `default_transaction_read_only: true` (boolean), then the session
 *    asserts `show default_transaction_read_only` = on and aborts otherwise. The checked-in
 *    smoke additionally proves a deliberate write FAILS under this connection.
 *  - PORTAL PREDICATE EXECUTED AS SQL: the acceptance test runs in Postgres itself, embedded
 *    verbatim from client-portal-prepship@d447d89 (money-validity + ps-508 + ps-509 lanes;
 *    ps-437 deliberately absent per the P4 lane-boundary enforcement). jsonb_typeof semantics
 *    therefore match the real Portal exactly — a numeric-string tuple is rejected here just
 *    as the Portal rejects it, even though Billing's reader would coerce it.
 *  - BOTH DIRECTIONS: a frozen row the Portal rejects is a mismatch (portal-rejects-frozen);
 *    a held row the Portal displays is a mismatch (portal-displays-held); a frozen row the
 *    Portal displays must agree to the cent.
 *  - CANONICAL CENTS: roundMoney (src/lib/money.ts) — ties away from zero — not Math.round.
 *  - LEGACY ROWS ARE OBSERVED, NEVER SELF-VALIDATED: verdict OBSERVED-LEGACY; the existing
 *    line is recorded, not treated as its own expectation.
 *  - EACH SHIPMENT COUNTS AT MOST ONCE in mismatchRows, whatever the number of defects.
 *  - NO FALSE GREEN: exit is nonzero unless the packet PASSES. INCOMPLETE (zero eligible
 *    rows, NOT-YET-COMPARED rows, missing cohorts, missing operator identity in activation
 *    mode) is a FAILURE exit, not a success.
 *
 * Modes:
 *  --mode inventory   (default) read-only survey; still exits nonzero on VIOLATED/INCOMPLETE.
 *  --mode activation  the acceptance gate. Additionally requires: nonempty valid --boundary;
 *                     operator readbacks (--env-clients-readback, --env-boundary-readback,
 *                     --readback-at) matching the inputs; deployed identities (--api-sha,
 *                     --worker-sha, --portal-sha) with --portal-sha REQUIRED to equal the
 *                     embedded mirror ref or the run fails as PORTAL-MIRROR-STALE; every
 *                     REQUIRED cohort represented or explicitly waived via
 *                     --waive "<cohort>:<reason>" (repeatable, recorded in the packet).
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import postgres from 'postgres';
import {
  decideBillableShippingMoney,
  type BillableShippingMoneyDecision,
} from '../src/services/customer-shipping-money-billable-decision';
import {
  classifyCustomerShippingMoney,
} from '../src/services/customer-shipping-money-classification';
import {
  resolveCutoverBoundary,
  isAfterCutover,
} from '../src/services/customer-shipping-money-cutover-gate';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
} from '../src/services/customer-shipping-money-snapshot';
import { roundMoney } from '../src/lib/money';

const PACKET_SCHEMA_VERSION = 2;
/** The Portal source this file's embedded SQL was copied from. Activation REQUIRES the
 *  deployed Portal SHA to start with this ref, or the packet fails PORTAL-MIRROR-STALE. */
const PORTAL_MIRROR_REF = 'd447d89';
const PORTAL_MIRROR_SOURCE = 'client-portal-prepship@' + PORTAL_MIRROR_REF
  + ' src/lib/client-portal/customer-shipping-rate.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
}
function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--' + name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out;
}

const DB_URL = process.env.PS508_PACKET_DATABASE_URL;
const MODE = (arg('mode') ?? 'inventory') as 'inventory' | 'activation';
const CLIENT = Number(arg('client'));
const BOUNDARY_RAW = arg('boundary') ?? '';
const FROM = arg('from');
const TO = arg('to');
const API = arg('api');
const OUT = arg('out');
const WAIVERS = new Map(args('waive').map((w) => {
  const idx = w.indexOf(':');
  return [w.slice(0, idx), w.slice(idx + 1)] as const;
}));

const problems: string[] = [];
if (!DB_URL) problems.push('PS508_PACKET_DATABASE_URL is not set');
if (!Number.isSafeInteger(CLIENT) || CLIENT <= 0) problems.push('--client must be a positive integer');
if (!FROM || !TO) problems.push('--from and --to are required');
if (!['inventory', 'activation'].includes(MODE)) problems.push('--mode must be inventory|activation');
const boundary = resolveCutoverBoundary(BOUNDARY_RAW);
if (boundary.kind === 'invalid') {
  problems.push('--boundary is unparseable ("' + BOUNDARY_RAW + '") — refusing to build a packet around a typo');
}
const operator = {
  envClientsReadback: arg('env-clients-readback') ?? null,
  envBoundaryReadback: arg('env-boundary-readback') ?? null,
  readbackAtUtc: arg('readback-at') ?? null,
  apiSha: arg('api-sha') ?? null,
  workerSha: arg('worker-sha') ?? null,
  portalSha: arg('portal-sha') ?? null,
  ciRunUrl: arg('ci-run-url') ?? null,
  pg17RunUrl: arg('pg17-run-url') ?? null,
  portalCiRunUrl: arg('portal-ci-run-url') ?? null,
};
if (MODE === 'activation') {
  if (boundary.kind !== 'at') problems.push('activation mode requires a nonempty valid --boundary');
  if (!operator.envClientsReadback) problems.push('activation requires --env-clients-readback (direct Render readback)');
  if (!operator.envBoundaryReadback) problems.push('activation requires --env-boundary-readback');
  if (!operator.readbackAtUtc) problems.push('activation requires --readback-at');
  if (!operator.apiSha) problems.push('activation requires --api-sha');
  if (!operator.workerSha) problems.push('activation requires --worker-sha');
  if (!operator.portalSha) problems.push('activation requires --portal-sha (deployed Portal SHA)');
  if (operator.envClientsReadback && operator.envClientsReadback.trim() !== String(CLIENT)) {
    problems.push('env-clients-readback ("' + operator.envClientsReadback + '") does not equal the pilot client ' + CLIENT);
  }
  if (operator.envBoundaryReadback && operator.envBoundaryReadback.trim() !== BOUNDARY_RAW.trim()) {
    problems.push('env-boundary-readback does not equal --boundary');
  }
  if (operator.portalSha && !operator.portalSha.startsWith(PORTAL_MIRROR_REF)) {
    problems.push('PORTAL-MIRROR-STALE: deployed Portal SHA ' + operator.portalSha
      + ' does not match the embedded mirror ref ' + PORTAL_MIRROR_REF
      + ' — re-embed the predicate from the deployed Portal before trusting portal parity');
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error('FAIL: ' + p);
  process.exit(1);
}
// Narrowed past the validation above; TypeScript cannot see through process.exit.
const FROM_ISO = FROM as string;
const TO_ISO = TO as string;

const accept = ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS;
/** Canonical dollars -> integer cents through the same rounding Billing persists with. */
const cents = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return null;
  const r = roundMoney(n);
  return Math.round(r * 100);
};

/**
 * The Portal outbound predicate, embedded VERBATIM (table alias s) from PORTAL_MIRROR_SOURCE.
 * Executed inside Postgres so the type semantics are the database's own, not a JS paraphrase.
 * ps-437 is absent from this union on purpose — the P4 lane-boundary enforcement.
 */
const PORTAL_VALID_MONEY_SQL = `
  coalesce(s.selected_rate_json, '{}'::jsonb) ?& array[
    'selectedRateCost','cShippingRateAmount','shippingMarginAmount','shippingMarginPct',
    'customerRateSource','rateCostSource','customerShippingMoneyPolicyVersion'
  ]::text[]
  and jsonb_typeof(s.selected_rate_json->'selectedRateCost') = 'number'
  and jsonb_typeof(s.selected_rate_json->'cShippingRateAmount') = 'number'
  and jsonb_typeof(s.selected_rate_json->'shippingMarginAmount') = 'number'
  and jsonb_typeof(s.selected_rate_json->'shippingMarginPct') in ('number', 'null')
  and (s.selected_rate_json->>'selectedRateCost')::numeric > 0
  and (s.selected_rate_json->>'cShippingRateAmount')::numeric > 0
  and round(
    (s.selected_rate_json->>'cShippingRateAmount')::numeric
      - (s.selected_rate_json->>'selectedRateCost')::numeric, 2
  ) = round((s.selected_rate_json->>'shippingMarginAmount')::numeric, 2)`;
const PORTAL_OUTBOUND_ACCEPTS_SQL = `
  ((${PORTAL_VALID_MONEY_SQL})
    and s.selected_rate_json->>'customerRateSource' in (
      'realized_customer_shipping_rate','hugrab_shipping_rate_override','house_next_best_customer_rate')
    and s.selected_rate_json->>'rateCostSource' = 'label_final_cost'
    and s.selected_rate_json->>'customerShippingMoneyPolicyVersion' = 'ps-508-v1'
    and jsonb_typeof(s.selected_rate_json->'billingDescriptionSuffix') = 'string'
    and not (coalesce(s.selected_rate_json, '{}'::jsonb) ? 'customerShippingMoneyCaptureSource'))
  or ((${PORTAL_VALID_MONEY_SQL})
    and s.selected_rate_json->>'customerRateSource' in (
      'carrier_markup_customer_shipping_rate','hugrab_shipping_rate_override')
    and s.selected_rate_json->>'rateCostSource' = 'shipstation_sync_receipt_cost'
    and s.selected_rate_json->>'customerShippingMoneyPolicyVersion' = 'ps-509-v1'
    and jsonb_typeof(s.selected_rate_json->'billingDescriptionSuffix') = 'string'
    and coalesce(s.selected_rate_json, '{}'::jsonb) ? 'customerShippingMoneyCaptureSource'
    and s.selected_rate_json->>'customerShippingMoneyCaptureSource' = 'shipstation_sync_ingestion')`;

const REQUIRED_COHORTS: Array<{ name: string; derivable: boolean }> = [
  { name: 'ordinary_purchase', derivable: true },
  { name: 'sync_ingress', derivable: true },
  { name: 'house_captured_rate', derivable: true },
  { name: 'multi_shipment', derivable: true },
  { name: 'voided', derivable: true },
  { name: 'return_isolation', derivable: true },
  { name: 'external_fulfillment_exclusion', derivable: true },
  // Not derivable from shipment rows alone; the operator either finds a pilot row and tags it
  // or waives with a recorded reason. Silent zeros are not accepted.
  { name: 'insurance_adjusted_final_cost', derivable: false },
  { name: 'markup_changed_after_purchase', derivable: false },
  { name: 'direct_carrier_purchase', derivable: false },
];

async function main(): Promise<void> {
  const sql = postgres(DB_URL as string, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    // BOOLEAN, not the string 'on' — the round-3 audit caught v1 passing a string, which the
    // client's types reject and which left server-side read-only unproven.
    connection: { default_transaction_read_only: true },
  });

  // Prove the session is what we claim before touching anything else.
  const [ro] = await sql.unsafe('show default_transaction_read_only');
  if ((ro as Record<string, string>).default_transaction_read_only !== 'on') {
    console.error('FAIL: session is NOT read-only (default_transaction_read_only='
      + (ro as Record<string, string>).default_transaction_read_only + '); refusing to run.');
    process.exit(1);
  }

  let apiHealth: Record<string, unknown> | null = null;
  if (API) {
    try {
      const res = await fetch(API.replace(/\/$/, '') + '/health');
      apiHealth = (await res.json()) as Record<string, unknown>;
    } catch (error) {
      apiHealth = { error: String(error).slice(0, 120) };
    }
  }
  let toolGitSha: string | null = null;
  try { toolGitSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { /* packaged run */ }

  const rows = (await sql.unsafe(`
    select s.id as shipment_id, s.order_id, s.client_id, s.ship_date, s.voided, s.is_return,
           s.source, s.selected_rate_json,
           (${PORTAL_OUTBOUND_ACCEPTS_SQL}) as portal_accepts,
           case when (${PORTAL_OUTBOUND_ACCEPTS_SQL})
                then (s.selected_rate_json->>'cShippingRateAmount')::numeric end as portal_amount,
           (select count(*) from shipments s2
             where s2.order_id = s.order_id and coalesce(s2.voided, false) = false) as order_shipment_count,
           o.order_number, o.externally_shipped,
           coalesce(o.raw->>'externallyFulfilled', 'false') = 'true' as externally_fulfilled
    from shipments s
    join orders o on o.id = s.order_id
    where s.client_id = $1 and s.ship_date >= $2 and s.ship_date < $3
    order by s.id
  `, [CLIENT, FROM_ISO, TO_ISO])) as unknown as Array<Record<string, unknown>>;

  const billed = (await sql.unsafe(`
    select shipment_id, line_type, description, unit_cost, total_cost, invoiced
    from billing_line_items
    where client_id = $1 and line_type in ('shipping', 'shipping_missing') and shipment_id is not null
  `, [CLIENT])) as unknown as Array<Record<string, unknown>>;
  const billedByShipment = new Map<number, Array<Record<string, unknown>>>();
  for (const b of billed) {
    const k = Number(b.shipment_id);
    if (!billedByShipment.has(k)) billedByShipment.set(k, []);
    billedByShipment.get(k)!.push(b);
  }

  const population: Array<Record<string, unknown>> = [];
  const shadow: Array<Record<string, unknown>> = [];
  const counts = {
    totalCandidateShipments: rows.length,
    eligibleShipments: 0,
    excludedReturns: 0,
    excludedVoids: 0,
    excludedExternalFulfillment: 0,
    preBoundaryLegacyRows: 0,
    postBoundaryValidFrozenRows: 0,
    postBoundaryMissingRows: 0,
    malformedRows: 0,
    unknownVersionRows: 0,
    undatedRows: 0,
    observedLegacyRows: 0,
    notYetComparedRows: 0,
    mismatchShipments: 0, // each shipment counted AT MOST once
  };
  const cohorts: Record<string, number> = {};
  const tag = (name: string) => { cohorts[name] = (cohorts[name] ?? 0) + 1; };

  for (const r of rows) {
    const shipDate = r.ship_date as Date | null;
    const excluded = Boolean(r.voided) ? 'voided'
      : Boolean(r.is_return) ? 'return'
      : Boolean(r.externally_shipped) || Boolean(r.externally_fulfilled) ? 'external_fulfillment'
      : null;
    if (excluded === 'return') { counts.excludedReturns += 1; tag('return_isolation'); }
    if (excluded === 'voided') { counts.excludedVoids += 1; tag('voided'); }
    if (excluded === 'external_fulfillment') { counts.excludedExternalFulfillment += 1; tag('external_fulfillment_exclusion'); }

    const j = (r.selected_rate_json ?? null) as Record<string, unknown> | null;
    const classification = classifyCustomerShippingMoney(j);
    const after = isAfterCutover(boundary, shipDate);
    if (shipDate == null) counts.undatedRows += 1;

    let decision: BillableShippingMoneyDecision | null = null;
    if (!excluded) {
      counts.eligibleShipments += 1;
      decision = decideBillableShippingMoney({
        selectedRateJson: j, accept, afterCutover: after,
        // Legacy expectations are NEVER computed here (mutable-config math belongs to the
        // regeneration); legacy rows are OBSERVED, not validated. Sentinel never surfaces.
        recompute: () => ({ amount: Number.NaN, descriptionSuffix: ' legacy' }),
      });
      if (decision.source === 'frozen' && after) counts.postBoundaryValidFrozenRows += 1;
      if (decision.source === 'review') {
        if (classification.kind === 'legacy_absent') counts.postBoundaryMissingRows += 1;
        else if (classification.kind === 'unknown_version') counts.unknownVersionRows += 1;
        else counts.malformedRows += 1;
      }
      if (decision.source === 'legacy_recompute') counts.preBoundaryLegacyRows += 1;
      if (j?.customerRateSource === 'house_next_best_customer_rate') tag('house_captured_rate');
      if (j?.customerShippingMoneyPolicyVersion === 'ps-509-v1') tag('sync_ingress');
      if (j?.customerShippingMoneyPolicyVersion === 'ps-508-v1') tag('ordinary_purchase');
      if (Number(r.order_shipment_count) > 1) tag('multi_shipment');
    }

    const portalAmountCents = cents(r.portal_amount);
    population.push({
      shipmentId: r.shipment_id, orderId: r.order_id, orderNumber: r.order_number,
      shipDate, source: r.source ?? null, excluded,
      policyVersion: j?.customerShippingMoneyPolicyVersion ?? null,
      tupleClassification: classification.kind, afterCutover: after,
      frozenAmountCents: decision?.source === 'frozen' ? cents(decision.value.amount) : null,
      portalAcceptsSql: Boolean(r.portal_accepts), portalAmountCents,
      expectedDisposition: excluded ?? (decision?.source ?? 'n/a'),
      reviewReason: decision?.source === 'review' ? decision.reason : null,
    });

    if (excluded || !decision) continue;
    const defects: string[] = [];
    const lines = billedByShipment.get(Number(r.shipment_id)) ?? [];

    if (decision.source === 'legacy_recompute') {
      // OBSERVED, never self-validated (round-3 correction 5).
      counts.observedLegacyRows += 1;
      if (portalAmountCents != null) defects.push('portal-displays-money-on-a-legacy-row');
      shadow.push({
        shipmentId: r.shipment_id, verdict: defects.length ? 'MISMATCH' : 'OBSERVED-LEGACY',
        expected: 'legacy_recompute',
        observedLines: lines.map((l) => ({ type: l.line_type, totalCents: cents(l.total_cost) })),
        detail: defects.length ? defects : undefined,
      });
      if (defects.length) counts.mismatchShipments += 1;
      continue;
    }

    if (lines.length === 0) {
      counts.notYetComparedRows += 1;
      shadow.push({ shipmentId: r.shipment_id, verdict: 'NOT-YET-COMPARED', expected: decision.source,
        note: 'no billing line yet — run the normal regeneration, then re-run this packet' });
      continue;
    }
    if (lines.length !== 1) defects.push('expected exactly one line, got ' + lines.length);
    const line = lines[0];
    if (decision.source === 'frozen') {
      const expectCents = cents(decision.value.amount);
      if (line.line_type !== 'shipping') defects.push('expected shipping, got ' + line.line_type);
      if (cents(line.total_cost) !== expectCents) defects.push('billed ' + line.total_cost + ' vs frozen ' + decision.value.amount);
      if (!String(line.description).includes(decision.value.descriptionSuffix)) defects.push('description missing the frozen suffix');
      // BOTH directions (round-3): the Portal must display this row and agree to the cent.
      if (portalAmountCents == null) defects.push('portal-rejects-frozen: the real Portal predicate rejects a tuple Billing bills');
      else if (portalAmountCents !== expectCents) defects.push('portal shows ' + portalAmountCents + 'c vs frozen ' + expectCents + 'c');
    } else { // review
      if (line.line_type !== 'shipping_missing' || cents(line.total_cost) !== 0) defects.push('expected a $0 shipping_missing hold');
      if (portalAmountCents != null) defects.push('portal-displays-held: the Portal shows a tuple Billing holds');
    }
    if (defects.length) counts.mismatchShipments += 1;
    shadow.push({
      shipmentId: r.shipment_id, verdict: defects.length ? 'MISMATCH' : 'MATCH',
      expected: decision.source, billedLineType: line.line_type, billedTotalCents: cents(line.total_cost),
      billedInvoiced: Boolean(line.invoiced), portalAmountCents,
      detail: defects.length ? defects : undefined,
    });
  }

  const cohortCoverage: Record<string, number | string> = {};
  const missingCohorts: string[] = [];
  for (const c of REQUIRED_COHORTS) {
    if (cohorts[c.name]) cohortCoverage[c.name] = cohorts[c.name];
    else if (WAIVERS.has(c.name)) cohortCoverage[c.name] = 'WAIVED: ' + WAIVERS.get(c.name);
    else { cohortCoverage[c.name] = 'NOT REPRESENTED'; missingCohorts.push(c.name); }
  }

  // ---- acceptance (round-3: no false green) --------------------------------------------------
  const failures: string[] = [];
  if (counts.mismatchShipments > 0) failures.push(counts.mismatchShipments + ' mismatching shipment(s)');
  if (counts.eligibleShipments === 0) failures.push('zero eligible shipments — an empty window proves nothing');
  if (counts.notYetComparedRows > 0) failures.push(counts.notYetComparedRows + ' row(s) not yet compared');
  if (missingCohorts.length > 0) failures.push('required cohorts not represented and not waived: ' + missingCohorts.join(', '));
  const verdict = counts.mismatchShipments > 0 ? 'VIOLATED' : failures.length > 0 ? 'INCOMPLETE' : 'PASS';

  const packet = {
    packetSchemaVersion: PACKET_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    mode: MODE,
    readOnly: { requested: true, sessionDefaultTransactionReadOnly: 'on' },
    toolGitSha,
    portalMirror: { ref: PORTAL_MIRROR_REF, source: PORTAL_MIRROR_SOURCE, executedAsSql: true },
    inputs: { clientId: CLIENT, boundary: BOUNDARY_RAW || '(none)', from: FROM_ISO, to: TO_ISO },
    identity: { apiHealth, operator },
    counts, cohortCoverage,
    waivers: Object.fromEntries(WAIVERS),
    verdict, failures,
    population, shadow,
  };

  const json = JSON.stringify(packet, null, 2);
  if (OUT) { fs.writeFileSync(OUT, json); console.log('packet written to ' + OUT); }
  else console.log(json);
  console.error('\nverdict=' + verdict + ' · shipments ' + rows.length + ' · eligible ' + counts.eligibleShipments
    + ' · mismatching ' + counts.mismatchShipments + ' · not-yet-compared ' + counts.notYetComparedRows
    + (failures.length ? '\nfailures:\n  - ' + failures.join('\n  - ') : ''));
  await sql.end({ timeout: 5 });
  process.exit(verdict === 'PASS' ? 0 : 1);
}

void main();
