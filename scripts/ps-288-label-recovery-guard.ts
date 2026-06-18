/**
 * PS-288 guard — recover an already-purchased ShipStation label whose local shipments.label_url
 * went NULL (shipment-sync never wrote it; "Send to Queue" greys out), WITHOUT buying new postage.
 * Pins the pure matcher + the print-queue recovery wiring (read /v2/labels, match, backfill url only).
 *
 *   npx tsx scripts/ps-288-label-recovery-guard.ts
 */
import { readFileSync } from 'node:fs';
import { matchRecoverableLabelUrl } from '../src/services/print-queue-label-recovery';
import { resolveSecondaryShipstationLabelKey } from '../src/services/print-queue-secondary-ss-account';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const LABELS = [
  { labelId: '111', shipmentId: 5001, trackingNumber: '1Z-AAA', labelUrl: 'https://ss/label/aaa.pdf' },
  { labelId: '222', shipmentId: 5002, trackingNumber: '1Z-BBB', labelUrl: 'https://ss/label/bbb.pdf' },
  { labelId: '333', shipmentId: 5003, trackingNumber: null, labelUrl: 'https://ss/label/ccc.pdf' },
];

// ── pure matcher: tracking first (unambiguous), then label_id, then shipment_id; only a record WITH a url ──
check('recovers by tracking number',
  matchRecoverableLabelUrl(LABELS, { trackingNumber: '1Z-BBB', labelShipmentId: 999 }) === 'https://ss/label/bbb.pdf');
check('recovers by label_id when tracking has no match (labelShipmentId is a ShipStation label_id)',
  matchRecoverableLabelUrl(LABELS, { trackingNumber: null, labelShipmentId: 333 }) === 'https://ss/label/ccc.pdf');
check('tracking wins over label_id',
  matchRecoverableLabelUrl(LABELS, { trackingNumber: '1Z-AAA', labelShipmentId: 222 }) === 'https://ss/label/aaa.pdf');
check('no match => null (no guess, no postage)',
  matchRecoverableLabelUrl(LABELS, { trackingNumber: 'NOPE', labelShipmentId: 0 }) === null);
check('empty recent-labels list => null',
  matchRecoverableLabelUrl([], { trackingNumber: '1Z-AAA', labelShipmentId: 111 }) === null);
check('skips a matching record that has no downloadable url',
  matchRecoverableLabelUrl([{ labelId: '1', shipmentId: 1, trackingNumber: 'T', labelUrl: null }], { trackingNumber: 'T', labelShipmentId: 1 }) === null);

// ── PS-288 continuation: SECOND ShipStation account key resolution (the KFG account) ──
check('resolves the secondary (KFG) account key from env',
  resolveSecondaryShipstationLabelKey({ SHIPSTATION_KFG_API_KEY_V2: 'kfg-key', SHIPSTATION_API_KEY_V2: 'primary-key' }) === 'kfg-key');
check('no secondary key configured => null (single-account behavior unchanged)',
  resolveSecondaryShipstationLabelKey({ SHIPSTATION_API_KEY_V2: 'primary-key' }) === null);
check('blank secondary key => null',
  resolveSecondaryShipstationLabelKey({ SHIPSTATION_KFG_API_KEY_V2: '   ', SHIPSTATION_API_KEY_V2: 'primary-key' }) === null);
check('secondary identical to primary => null (avoids a redundant re-read of the same labels)',
  resolveSecondaryShipstationLabelKey({ SHIPSTATION_KFG_API_KEY_V2: 'same', SHIPSTATION_API_KEY_V2: 'same' }) === null);

// ── PS-288 continuation: the multi-account fallback matches the SECOND account's labels by the
// SAME exact matcher, so the KFG account recovers a label the primary account never sold while a
// non-matching second-account label set still yields null (no cross-account false positive) ──
const KFG_LABELS = [
  { labelId: '888', shipmentId: 7001, trackingNumber: '1Z-KFG', labelUrl: 'https://ss/label/kfg.pdf' },
];
check('second account recovers by tracking when the primary set had no match',
  matchRecoverableLabelUrl(KFG_LABELS, { trackingNumber: '1Z-KFG', labelShipmentId: 0 }) === 'https://ss/label/kfg.pdf');
check('a non-matching second-account set still yields null (exact match, no cross-account false positive)',
  matchRecoverableLabelUrl(KFG_LABELS, { trackingNumber: '1Z-NOPE', labelShipmentId: 12345 }) === null);

// ── structural pins on the print-queue recovery wiring (lockdown-safe) ──
const pq = readFileSync('src/services/print-queue.ts', 'utf8').replace(/\r\n/g, '\n');
const fnBody = pq.match(/async function findExistingQueueableLabelForOrder[\s\S]*?\n}\n/)?.[0] ?? '';
check('recovery wiring exists in findExistingQueueableLabelForOrder', fnBody.length > 0);
check('recovery reads ShipStation recent labels + uses the pure matcher',
  fnBody.includes('ssListRecentLabels') && fnBody.includes('matchRecoverableLabelUrl'));
check('recovery buys NO postage (no createLabelV2 in the recovery function)',
  fnBody.length > 0 && !fnBody.includes('createLabelV2'));
check('recovery backfills ONLY labelUrl + labelFormat (no other shipped column written)',
  /\.set\(\{[^}]*labelUrl:[^}]*labelFormat:[^}]*\}\)/.test(fnBody));
check('recovery only touches NON-voided shipments (no cancelled/voided rows)',
  fnBody.includes('shipments.voided, false') || pq.includes('eq(shipments.voided, false)'));
check('recovery write carries the unlock-shipped-data override note (2026-06-18)',
  /Per user override unlock shipped data on 2026-06-18/.test(pq));

// ── PS-288 continuation: multi-account recovery wiring (try the SECOND ShipStation account) ──
check('recovery falls back to the SECOND ShipStation account key when the primary set had no match',
  fnBody.includes('resolveSecondaryShipstationLabelKey'));
check('the secondary fallback re-reads recent labels (ssListRecentLabels called with the secondary key)',
  /ssListRecentLabels\(\s*secondaryKey/.test(fnBody) || /resolveSecondaryShipstationLabelKey[\s\S]*ssListRecentLabels\(/.test(fnBody));
check('the secondary fallback reuses the EXISTING pure matcher (no second matcher, exact-match only)',
  (fnBody.match(/matchRecoverableLabelUrl/g) ?? []).length >= 2);
check('the secondary fallback still buys NO postage (no createLabelV2 in the recovery function)',
  fnBody.length > 0 && !fnBody.includes('createLabelV2'));

if (failures > 0) { console.error(`\nFAIL PS-288 label-recovery guard (${failures} failing)`); process.exit(1); }
console.log('\nPASS PS-288 label-recovery guard');
