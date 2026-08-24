/**
 * PS-508 — the canary evidence packet, as one read-only command.
 *
 * The Hermes 82% re-audit defined the exact packet DJ must return from the canary: identity
 * manifest, pre-activation configuration readback, population manifest with per-row tuple
 * classification, shadow-result rows in cents, cohort coverage, the zero-mismatch verdict, and
 * rollback fields. This tool produces sections 3-7 mechanically and leaves the operator-only
 * fields (Render env readback, deployed SHAs it cannot fetch) as explicit REQUIRED-OPERATOR
 * blanks — never silently filled.
 *
 * STRICTLY READ-ONLY. It opens the connection with
 *   default_transaction_read_only = on
 * so even a bug in this file cannot write. "Shadow parity" here is computed through the REAL
 * decision owner (decideBillableShippingMoney — the same code Billing runs) and compared
 * SELECT-only against existing billing_line_items rows and the Portal predicate. It never
 * invokes generateLineItems, which is a regeneration and therefore a write: rows the normal
 * regeneration has not produced yet are reported NOT-YET-COMPARED, not guessed.
 *
 * Usage:
 *   PS508_PACKET_DATABASE_URL=postgres://... npx tsx scripts/ps-508-canary-evidence-packet.ts \
 *     --client 4 --boundary 2026-09-01T00:00:00Z --from 2026-08-01 --to 2026-09-15 \
 *     [--api https://prepshipv4-api-l5xc.onrender.com] [--out packet.json]
 */
import fs from 'node:fs';
import postgres from 'postgres';
import {
  classifyCustomerShippingMoney,
} from '../src/services/customer-shipping-money-classification';
import {
  decideBillableShippingMoney,
  type BillableShippingMoneyDecision,
} from '../src/services/customer-shipping-money-billable-decision';
import {
  resolveCutoverBoundary,
  isAfterCutover,
} from '../src/services/customer-shipping-money-cutover-gate';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
} from '../src/services/customer-shipping-money-snapshot';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const DB_URL = process.env.PS508_PACKET_DATABASE_URL;
const CLIENT = Number(arg('client'));
const BOUNDARY_RAW = arg('boundary') ?? '';
const FROM = arg('from');
const TO = arg('to');
const API = arg('api');
const OUT = arg('out');

if (!DB_URL || !Number.isFinite(CLIENT) || !FROM || !TO) {
  console.error('usage: PS508_PACKET_DATABASE_URL=... npx tsx scripts/ps-508-canary-evidence-packet.ts'
    + ' --client <id> --boundary <ISO|empty> --from <ISO> --to <ISO> [--api <url>] [--out <file>]');
  process.exit(1);
}

const boundary = resolveCutoverBoundary(BOUNDARY_RAW);
if (boundary.kind === 'invalid') {
  console.error('FAIL: --boundary is unparseable ("' + BOUNDARY_RAW + '"). The gate treats an invalid'
    + ' boundary as fail-closed for every shipment; refusing to build a packet around a typo.');
  process.exit(1);
}
const accept = ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS;

const cents = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * The Portal's outbound acceptance, mirrored VERBATIM from client-portal-prepship
 * src/lib/client-portal/customer-shipping-rate.ts @ PR #29 (9cfef59). If the Portal predicate
 * changes, this must change with it — the packet's portal-parity leg is only as honest as this
 * mirror, so the source SHA is recorded in the packet.
 */
const PORTAL_PREDICATE_SOURCE = 'client-portal-prepship@9cfef59 customer-shipping-rate.ts';
function portalAcceptsOutbound(j: Record<string, unknown>): boolean {
  const money = Number(j.cShippingRateAmount);
  if (!Number.isFinite(money)) return false;
  const version = j.customerShippingMoneyPolicyVersion;
  const rateSource = j.customerRateSource;
  const costSource = j.rateCostSource;
  const suffixOk = typeof j.billingDescriptionSuffix === 'string';
  const hasCapture = 'customerShippingMoneyCaptureSource' in j;
  if (version === 'ps-437-v1') {
    return ['realized_customer_shipping_rate', 'hugrab_shipping_rate_override'].includes(String(rateSource))
      && costSource === 'label_final_cost' && !hasCapture;
  }
  if (version === 'ps-508-v1') {
    return ['realized_customer_shipping_rate', 'hugrab_shipping_rate_override', 'house_next_best_customer_rate']
      .includes(String(rateSource))
      && costSource === 'label_final_cost' && suffixOk && !hasCapture;
  }
  if (version === 'ps-509-v1') {
    return ['carrier_markup_customer_shipping_rate', 'hugrab_shipping_rate_override'].includes(String(rateSource))
      && costSource === 'shipstation_sync_receipt_cost' && suffixOk
      && j.customerShippingMoneyCaptureSource === 'shipstation_sync_ingestion';
  }
  return false;
}

async function main(): Promise<void> {
  // READ-ONLY at the session level: even a bug in this file cannot write.
  const sql = postgres(DB_URL as string, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { default_transaction_read_only: 'on' },
  });

  let apiHealth: Record<string, unknown> | null = null;
  if (API) {
    try {
      const res = await fetch(API.replace(/\/$/, '') + '/health');
      apiHealth = (await res.json()) as Record<string, unknown>;
    } catch (error) {
      apiHealth = { error: String(error).slice(0, 120) };
    }
  }

  const rows = (await sql`
    select s.id as shipment_id, s.order_id, s.client_id, s.ship_date, s.voided, s.is_return,
           s.source, s.selected_rate_json,
           o.order_number, o.externally_shipped,
           coalesce(o.raw->>'externallyFulfilled', 'false') = 'true' as externally_fulfilled
    from shipments s
    join orders o on o.id = s.order_id
    where s.client_id = ${CLIENT}
      and s.ship_date >= ${FROM} and s.ship_date < ${TO}
    order by s.id
  `) as unknown as Array<Record<string, unknown>>;

  const billed = (await sql`
    select shipment_id, line_type, description, unit_cost, total_cost, invoiced
    from billing_line_items
    where client_id = ${CLIENT} and line_type in ('shipping', 'shipping_missing')
      and shipment_id is not null
  `) as unknown as Array<Record<string, unknown>>;
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
    notYetComparedRows: 0,
    mismatchRows: 0,
  };
  const cohorts: Record<string, number> = {};
  const tag = (name: string) => { cohorts[name] = (cohorts[name] ?? 0) + 1; };

  for (const r of rows) {
    const shipDate = r.ship_date as Date | null;
    const excluded = Boolean(r.voided) ? 'voided'
      : Boolean(r.is_return) ? 'return'
      : Boolean(r.externally_shipped) || Boolean(r.externally_fulfilled) ? 'external_fulfillment'
      : null;
    if (excluded === 'return') counts.excludedReturns += 1;
    if (excluded === 'voided') counts.excludedVoids += 1;
    if (excluded === 'external_fulfillment') counts.excludedExternalFulfillment += 1;

    const j = (r.selected_rate_json ?? null) as Record<string, unknown> | null;
    const classification = classifyCustomerShippingMoney(j);
    const after = isAfterCutover(boundary, shipDate);
    if (shipDate == null) counts.undatedRows += 1;

    let decision: BillableShippingMoneyDecision | null = null;
    if (!excluded) {
      counts.eligibleShipments += 1;
      decision = decideBillableShippingMoney({
        selectedRateJson: j,
        accept,
        afterCutover: after,
        // The packet must never invoke the mutable-config calculation: a legacy row's expected
        // amount is whatever the NORMAL regeneration produced, compared below from the billed
        // line itself. The sentinel never reaches output for frozen/review rows.
        recompute: () => ({ amount: Number.NaN, descriptionSuffix: ' legacy' }),
      });
      if (decision.source === 'frozen') counts.postBoundaryValidFrozenRows += Number(after);
      if (decision.source === 'review') {
        if (classification.kind === 'legacy_absent') counts.postBoundaryMissingRows += 1;
        else if (classification.kind === 'unknown_version') counts.unknownVersionRows += 1;
        else counts.malformedRows += 1;
      }
      if (decision.source === 'legacy_recompute') counts.preBoundaryLegacyRows += 1;
    }

    // cohort tags
    if (j?.customerRateSource === 'house_next_best_customer_rate') tag('house_captured_rate');
    if (j?.customerShippingMoneyPolicyVersion === 'ps-509-v1') tag('sync_ingress');
    if (j?.customerShippingMoneyPolicyVersion === 'ps-508-v1') tag('ordinary_purchase');
    if (Boolean(r.voided)) tag('voided');
    if (Boolean(r.is_return)) tag('return_isolation');
    if (excluded === 'external_fulfillment') tag('external_fulfillment_exclusion');

    population.push({
      shipmentId: r.shipment_id,
      orderId: r.order_id,
      orderNumber: r.order_number,
      shipDate,
      excluded,
      policyVersion: j?.customerShippingMoneyPolicyVersion ?? null,
      tupleClassification: classification.kind,
      afterCutover: after,
      frozenAmountCents: decision?.source === 'frozen' ? cents(decision.value.amount) : null,
      frozenSuffix: decision?.source === 'frozen' ? decision.value.descriptionSuffix : null,
      expectedDisposition: excluded ?? (decision?.source ?? 'n/a'),
      reviewReason: decision?.source === 'review' ? decision.reason : null,
    });

    // shadow comparison against EXISTING billing lines (SELECT-only; regeneration is DJ's op)
    if (!excluded && decision) {
      const lines = billedByShipment.get(Number(r.shipment_id)) ?? [];
      if (lines.length === 0) {
        counts.notYetComparedRows += 1;
        shadow.push({ shipmentId: r.shipment_id, verdict: 'NOT-YET-COMPARED',
          note: 'no billing line yet — run the normal regeneration, then re-run this packet' });
        continue;
      }
      const line = lines[0];
      let verdict = 'MATCH';
      const detail: string[] = [];
      if (lines.length !== 1) { verdict = 'MISMATCH'; detail.push('expected exactly one line, got ' + lines.length); }
      if (decision.source === 'frozen') {
        if (line.line_type !== 'shipping') { verdict = 'MISMATCH'; detail.push('expected shipping, got ' + line.line_type); }
        if (cents(line.total_cost) !== cents(decision.value.amount)) {
          verdict = 'MISMATCH';
          detail.push('billed ' + line.total_cost + ' vs frozen ' + decision.value.amount);
        }
        if (!String(line.description).includes(decision.value.descriptionSuffix)) {
          verdict = 'MISMATCH'; detail.push('description missing the frozen suffix');
        }
      } else if (decision.source === 'review') {
        if (line.line_type !== 'shipping_missing' || cents(line.total_cost) !== 0) {
          verdict = 'MISMATCH'; detail.push('expected a $0 shipping_missing hold');
        }
      } // legacy_recompute: the billed line IS the expectation; nothing to diff against itself.
      if (verdict === 'MISMATCH') counts.mismatchRows += 1;
      const portalValue = j && portalAcceptsOutbound(j) ? cents(j.cShippingRateAmount) : null;
      const portalDisagrees = decision.source === 'review' && portalValue != null;
      if (portalDisagrees) { verdict = 'MISMATCH'; counts.mismatchRows += 1; detail.push('Portal would display a tuple Billing holds'); }
      shadow.push({
        shipmentId: r.shipment_id, verdict,
        expected: decision.source,
        billedLineType: line.line_type,
        billedTotalCents: cents(line.total_cost),
        billedInvoiced: Boolean(line.invoiced),
        portalShipmentAmountCents: portalValue,
        detail: detail.length ? detail : undefined,
      });
    }
  }

  const REQUIRED_COHORTS = ['ordinary_purchase', 'sync_ingress', 'house_captured_rate', 'voided',
    'return_isolation', 'external_fulfillment_exclusion'];
  const cohortCoverage = Object.fromEntries(
    REQUIRED_COHORTS.map((c) => [c, cohorts[c] ? cohorts[c] : 'NOT REPRESENTED']),
  );

  const packet = {
    generatedAtUtc: new Date().toISOString(),
    readOnly: true,
    portalPredicateSource: PORTAL_PREDICATE_SOURCE,
    inputs: { clientId: CLIENT, boundary: BOUNDARY_RAW || '(none)', from: FROM, to: TO },
    identity: {
      apiHealth,
      // These CANNOT be fetched by a read-only DB tool. Blank on purpose: the operator fills
      // them from the Render dashboard / Vercel, per the audit's identity-manifest section.
      REQUIRED_OPERATOR_renderEnvReadback: {
        PS508_BILLING_FROZEN_TUPLE_CLIENTS: null,
        PS508_BILLING_FROZEN_TUPLE_CUTOVER_AT: null,
        readbackTimestampUtc: null,
      },
      REQUIRED_OPERATOR_portalLiveDeploymentSha: null,
    },
    counts,
    cohortCoverage,
    zeroMismatch: counts.mismatchRows === 0 && counts.notYetComparedRows === 0
      ? 'HOLDS (on compared rows)'
      : counts.mismatchRows > 0 ? 'VIOLATED' : 'INCOMPLETE — rows not yet compared',
    population,
    shadow,
  };

  const json = JSON.stringify(packet, null, 2);
  if (OUT) { fs.writeFileSync(OUT, json); console.log('packet written to ' + OUT); }
  else console.log(json);
  console.error(`\nsummary: ${rows.length} shipments · eligible ${counts.eligibleShipments}`
    + ` · mismatches ${counts.mismatchRows} · not-yet-compared ${counts.notYetComparedRows}`
    + ` · zeroMismatch=${packet.zeroMismatch}`);
  await sql.end({ timeout: 5 });
  process.exit(counts.mismatchRows > 0 ? 1 : 0);
}

void main();
