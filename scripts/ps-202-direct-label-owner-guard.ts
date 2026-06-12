/**
 * PS-202 guard — direct-carrier label purchases have ONE owner: v4 /labels.
 *
 * THE GAP: apiClient.createLabel routed direct carrier-account rates
 * (synthetic 10M+/20M+ provider ids) to the LEGACY Vercel function — real
 * postage on a separately-deployed stack with a forked auth verifier and NO
 * inventory/package deduction.
 *
 * THE FIX: createLabelV2 intercepts synthetic ids and buys through the v4
 * carrier connectors via labels-direct, with the SAME proof gate, shipping
 * safety, eligibility, persistence, deduction, and marketplace-confirmation
 * tail as ShipStation labels. Walmart Shipping uses the PS-199 labels-mode
 * resolver (always live-verifies the PO; throws rather than buy unverified).
 * The FE branch is deleted — createLabel posts ONLY to v4 /labels.
 *
 * Read-only source guard; no network, no postage.
 *
 *   npx tsx scripts/ps-202-direct-label-owner-guard.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── FE: no path in web/src ever posts a label to the legacy Vercel endpoint ──
const files: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d)) {
    const p = join(d, e); const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'node_modules') walk(p); }
    else if (/\.(ts|tsx)$/.test(p)) files.push(p);
  }
})('web/src');
const offenders = files.filter((f) => /callVercelFunction[^\n]{0,80}carriers\/labels/.test(readFileSync(f, 'utf8')));
check('no web/src file calls the legacy Vercel direct-label endpoint', offenders.length === 0, offenders.join(', '));

const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
{
  const start = apiClient.indexOf('createLabel(payload: unknown)');
  const block = apiClient.slice(start, apiClient.indexOf('retrieveLabel(', start));
  check('createLabel posts ONLY to v4 /labels',
    start >= 0 && /api\.post<any>\('\/labels', payload\)/.test(block) && !/callVercelFunction/.test(block));
}

// ── BE: the direct branch sits BEHIND the proof gate + safety asserts ─────────
const labels = readFileSync('src/services/labels.ts', 'utf8');
{
  const proofGate = labels.indexOf('await assertLabelPurchaseRateSelection({');
  const directBranch = labels.indexOf('directLabelAccountRefFromProviderId(body.shippingProviderId)');
  const persistTail = labels.indexOf("await timer.task('persistCreatedLabel'");
  check('direct purchases run AFTER the rate-proof gate (PS-105) and BEFORE the shared persist tail',
    proofGate > 0 && directBranch > proofGate && persistTail > directBranch);
}
check('direct purchases assert the DIRECT carrier family (PS-106 purchase boundary)',
  /carrierFamily: 'direct',\s*\n\s*order,/.test(labels));
check('direct purchases reuse the SAME deduction tail as ShipStation labels (the legacy gap)',
  /recordFulfillmentDeductions\(\{\s*\n\s*order,\s*\n\s*shipmentId: localShipmentId/.test(labels));
check('direct shipments keep the legacy source attribution (shipp/walmart_shipping rows)',
  /source: directProviderKey \?\? 'prepship_v2'/.test(labels));
check('walmart confirmations get the live-verified PO (the PS-201 failure class)',
  /directWalmartContext && confirmationProvider === 'walmart'/.test(labels) &&
  /purchaseOrderId: directWalmartContext\.purchaseOrderId/.test(labels));

// ── labels-direct: scope assert, PS-199 labels mode, test-mode seam ───────────
const labelsDirect = readFileSync('src/services/labels-direct.ts', 'utf8');
check('account loading enforces the PS-083 assignment scope before postage',
  /directCarrierVisibleForScope\(account, \{ clientId: scope\.clientId/.test(labelsDirect) &&
  /DIRECT_CARRIER_NOT_ASSIGNED/.test(labelsDirect));
check('walmart_shipping uses the PS-199 LABELS-mode resolver (live-verify or throw)',
  /resolveWalmartPurchaseOrder\(/.test(labelsDirect) && /'labels',\s*\n\s*\)/.test(labelsDirect));
check('the orchestrator test-mode seam is reachable ($0 verification path)',
  /__carrierTestMode: true/.test(labelsDirect) &&
  // PS-202 verification (2026-06-12): the seam must be WIRED from createLabelV2's
  // direct branch, not merely declared — the original pin checked the string in
  // labels-direct while no caller ever set args.carrierTestMode. Double-gated:
  // inert unless CARRIER_TEST_MODE is also armed in the env.
  /carrierTestMode: \(body as Record<string, unknown>\)\.__carrierTestMode === true/.test(labels));
check('a missing tracking number fails the purchase (no half-recorded labels)',
  /returned no tracking number/.test(labelsDirect));
check('synthetic id mapping covers both account tables',
  /DIRECT_STORE_PROVIDER_ID_OFFSET = 20_000_000/.test(labelsDirect) &&
  /DIRECT_CARRIER_PROVIDER_ID_OFFSET = 10_000_000/.test(labelsDirect));

if (failures > 0) {
  console.error(`\nFAIL PS-202 direct-label owner guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-202 direct-label owner guard');
