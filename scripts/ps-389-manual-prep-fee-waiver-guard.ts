/**
 * PS-389 - Manual Billing Pick & Pack $0 edits must persist as backend SOT.
 *
 * This guard is intentionally static/offline: no DB, no live billing writes.
 * It pins the normal Edit Billing Detail PATCH route to the same durable
 * billing_fee_waivers owner that regeneration already consumes.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(message: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${message}`);
  } else {
    console.log(`ok   ${message}`);
  }
}

const route = readFileSync('src/routes/billing.ts', 'utf8');
const service = readFileSync('src/services/billing.ts', 'utf8');
const store = readFileSync('src/services/billing-fee-waiver-store.ts', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

const patchStart = route.indexOf("app.patch('/details/:orderId");
const patchEnd = route.indexOf('//', route.indexOf('return c.json({ ok: true', patchStart));
const patchBlock = patchStart >= 0 && patchEnd > patchStart ? route.slice(patchStart, patchEnd) : '';

check('PS-389: details PATCH route exists', patchBlock.length > 0);
check(
  'PS-389: details PATCH uses the durable billing_fee_waivers owner',
  /ensureBillingFeeWaiverSchema\(\)/.test(patchBlock) &&
    /upsertBillingFeeWaiver\(/.test(patchBlock),
);
check(
  'PS-389: manual Pick & Pack $0 records a waived decision',
  /body\.pickPack\s*!==\s*undefined/.test(patchBlock) &&
    /money\(body\.pickPack\)\s*===\s*'0\.00'/.test(patchBlock) &&
    /decision:\s*'waived'/.test(patchBlock),
);
check(
  'PS-389: manual positive prep edit clears a stale waiver as not_waived',
  /manualPrepFeeDecision\s*=\s*'not_waived'/.test(patchBlock) &&
    /manualPrepFeeDecision/.test(patchBlock),
);
check(
  'PS-389: original prep amount is captured from canonical prep line types before route updates generated rows',
  /PREP_FEE_LINE_TYPE_LIST/.test(patchBlock) &&
    /original_prep_amount/.test(patchBlock) &&
    patchBlock.indexOf('original_prep_amount') < patchBlock.indexOf('for (const [bodyKey, lineType, description]'),
);
check(
  'PS-389: line-item edit and durable waiver write run inside the same transaction body',
  /await db\.transaction\(async \(tx\) =>/.test(patchBlock) &&
    patchBlock.indexOf('upsertBillingFeeWaiver(') > patchBlock.indexOf('await db.transaction'),
);
check(
  'PS-389: audit event records the manual prep fee waiver decision',
  /resourceType:\s*'billing_fee_waiver'/.test(patchBlock) &&
    /action:\s*manualPrepFeeAudit\.decision/.test(patchBlock),
);
check(
  'PS-389: waiver store supports transaction executors for atomic details PATCH writes',
  /type BillingFeeWaiverExecutor/.test(store) &&
    /executor:\s*BillingFeeWaiverExecutor/.test(store),
);
check(
  'PS-389: generator already consumes billing_fee_waivers before final billing_line_items are inserted',
  /await readBillingFeeWaivers\(orderIdsInScope\)/.test(service) &&
    /const effectiveRows: LineRow\[\][\s\S]*applyPrepFeeWaiver\(rows, waived\)/.test(service) &&
    /for \(const row of effectiveRows\)/.test(service),
);
check(
  'PS-389: package exposes the focused manual prep-fee waiver guard',
  packageJson.scripts?.['test:ps-389-manual-prep-fee-waiver'] ===
    'tsx scripts/ps-389-manual-prep-fee-waiver-guard.ts',
);

if (failures > 0) {
  console.error(`\nFAIL PS-389 manual prep-fee waiver guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-389 manual prep-fee waiver guard');
