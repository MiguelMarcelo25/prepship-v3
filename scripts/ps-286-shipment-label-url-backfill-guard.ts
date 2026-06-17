/**
 * PS-286 — shipment label_url backfill/resolver guard (PURE, offline).
 *
 * Boundary test at the SOURCE OF TRUTH for shipments.label_url. The sync write path
 * (src/services/shipment-sync.ts) and the one-time backfill
 * (scripts/ps-286-shipment-label-url-backfill.ts) both delegate to the pure planner
 * planShipmentLabelUrlBackfill(). This guard pins its behavior so neither writer can
 * overwrite an existing URL, fabricate one, or accept a corrupt value.
 *
 * Why this exists: 72% of synced shipped shipments landed with label_url = NULL because
 * shipment-sync never captured the ShipStation v2 label-download URL, which greyed
 * "Send to Queue" across the Shipped view. Per user override `unlock shipped data` on
 * 2026-06-17: the resolver may FILL a null label_url from the authoritative ShipStation
 * label record (matched by ssShipmentId) and NOTHING else.
 *
 * Offline / pure: imports the planner only; no DB, no network.
 */
import { readFileSync } from 'node:fs';
import {
  isUsableLabelUrl,
  planShipmentLabelUrlBackfill,
} from '../src/services/shipping-workflow/shipment-label-url-backfill';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const GOOD_URL = 'https://api.shipstation.com/v2/downloads/15/QEb1Hc1GBkGJ37QT';
const OTHER_URL = 'https://api.shipstation.com/v2/downloads/99/ZZZ';

// ── isUsableLabelUrl ──────────────────────────────────────────────────────────
check('isUsableLabelUrl accepts a real URL', isUsableLabelUrl(GOOD_URL));
check('isUsableLabelUrl rejects null', !isUsableLabelUrl(null));
check('isUsableLabelUrl rejects undefined', !isUsableLabelUrl(undefined));
check('isUsableLabelUrl rejects empty / whitespace', !isUsableLabelUrl('') && !isUsableLabelUrl('   '));
check('isUsableLabelUrl rejects the [object Object] sentinel', !isUsableLabelUrl('[object Object]'));

// ── planShipmentLabelUrlBackfill ──────────────────────────────────────────────
// Match key is TRACKING NUMBER (not shipment id): ShipStation's v1 shipment id —
// what shipments.label_shipment_id stores — does NOT align with the v2 /v2/labels
// shipment id, but the tracking number is identical across both, like the existing
// enrichProviderAccountIds join.

// (1) fills a NULL label_url from the matching label record (by tracking number)
{
  const updates = planShipmentLabelUrlBackfill(
    [{ shipmentId: 26413, trackingNumber: '1Z999AA10123456784', labelUrl: null }],
    [{ trackingNumber: '1Z999AA10123456784', labelUrl: GOOD_URL }],
  );
  check('fills a null label_url from the tracking-number match',
    updates.length === 1 && updates[0]?.shipmentId === 26413 && updates[0]?.labelUrl === GOOD_URL,
    JSON.stringify(updates));
}

// (2) matches case/whitespace-insensitively (v1 vs v2 formatting differences)
{
  const updates = planShipmentLabelUrlBackfill(
    [{ shipmentId: 7, trackingNumber: ' 1z999aa10123456784 ', labelUrl: null }],
    [{ trackingNumber: '1Z999AA10123456784', labelUrl: GOOD_URL }],
  );
  check('matches tracking numbers case/whitespace-insensitively',
    updates.length === 1 && updates[0]?.labelUrl === GOOD_URL, JSON.stringify(updates));
}

// (3) NEVER overwrites an existing usable label_url (idempotent / non-destructive)
{
  const updates = planShipmentLabelUrlBackfill(
    [{ shipmentId: 1, trackingNumber: 'TRACK1', labelUrl: OTHER_URL }],
    [{ trackingNumber: 'TRACK1', labelUrl: GOOD_URL }],
  );
  check('never overwrites an existing label_url', updates.length === 0, JSON.stringify(updates));
}

// (4) skips rows with no tracking number (nothing to match on)
{
  const updates = planShipmentLabelUrlBackfill(
    [{ shipmentId: 2, trackingNumber: null, labelUrl: null }],
    [{ trackingNumber: 'TRACK1', labelUrl: GOOD_URL }],
  );
  check('skips rows with a null tracking number', updates.length === 0, JSON.stringify(updates));
}

// (5) skips when no label record matches the shipment
{
  const updates = planShipmentLabelUrlBackfill(
    [{ shipmentId: 3, trackingNumber: 'NOPE', labelUrl: null }],
    [{ trackingNumber: 'TRACK1', labelUrl: GOOD_URL }],
  );
  check('skips when no label record matches', updates.length === 0, JSON.stringify(updates));
}

// (6) rejects corrupt / empty label records — never writes a bad URL
{
  const updates = planShipmentLabelUrlBackfill(
    [
      { shipmentId: 4, trackingNumber: 'T100', labelUrl: null },
      { shipmentId: 5, trackingNumber: 'T200', labelUrl: null },
    ],
    [
      { trackingNumber: 'T100', labelUrl: '[object Object]' },
      { trackingNumber: 'T200', labelUrl: '' },
    ],
  );
  check('never produces an update from a corrupt or empty label record',
    updates.length === 0, JSON.stringify(updates));
}

// (7) when duplicate label records share a tracking number, uses the first USABLE one
{
  const updates = planShipmentLabelUrlBackfill(
    [{ shipmentId: 6, trackingNumber: 'T300', labelUrl: null }],
    [
      { trackingNumber: 'T300', labelUrl: '[object Object]' }, // corrupt, skipped
      { trackingNumber: 'T300', labelUrl: GOOD_URL },          // first usable wins
    ],
  );
  check('uses the first usable label record when tracking numbers duplicate',
    updates.length === 1 && updates[0]?.labelUrl === GOOD_URL, JSON.stringify(updates));
}

// ── (7) shipped-protection source assertions on the runnable backfill ─────────
// The override `unlock shipped data` permits ONLY filling a null label_url. Pin that the
// script's single UPDATE writes label_url, is NULL-guarded, and is double-gated to apply.
const backfill = readFileSync('scripts/ps-286-shipment-label-url-backfill.ts', 'utf8');
const updateBlocks = backfill.match(/\.update\(shipments\)[\s\S]*?;/g) ?? [];
check('backfill has exactly one shipments UPDATE', updateBlocks.length === 1, `found ${updateBlocks.length}`);
check('the UPDATE sets label_url only (no other shipped column)',
  updateBlocks.length === 1
  && /\.set\(\{\s*labelUrl: u\.labelUrl\s*\}\)/.test(updateBlocks[0]!)
  && !/trackingNumber|carrierCode|serviceCode|cost|voided|orderStatus|labelShipmentId|providerAccountId/.test(updateBlocks[0]!));
check('the UPDATE is guarded isNull(shipments.labelUrl) (never overwrites)',
  updateBlocks.length === 1 && /isNull\(shipments\.labelUrl\)/.test(updateBlocks[0]!));
check('apply is double-gated (--apply AND --confirm-production)',
  /hasFlag\('apply'\)/.test(backfill) && /hasFlag\('confirm-production'\)/.test(backfill)
  && /const willApply = apply && confirmProduction/.test(backfill));
check('backfill records the override in a nearby comment',
  /unlock shipped data` on 2026-06-17/.test(backfill));
check('backfill reads shipments only when label_url IS NULL + not voided',
  /isNull\(shipments\.labelUrl\)/.test(backfill) && /eq\(shipments\.voided, false\)/.test(backfill));

if (failures > 0) {
  console.error(`\nFAIL PS-286 shipment label_url backfill guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-286 shipment label_url backfill guard (resolver fills null URLs only; backfill UPDATE is label_url-only, NULL-guarded, double-gated)');
