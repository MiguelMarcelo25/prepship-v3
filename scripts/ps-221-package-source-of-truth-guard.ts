/**
 * PS-221 guard (Slice 1) — the persisted package == the deducted package.
 *
 * Per user override unlock shipped data on 2026-06-13. The real ShipStation /
 * direct label path used to persist shipments.selected_package_id from the RAW
 * body.customPackageId while deducting inventory from the RESOLVED package
 * (resolvedPackageId) — so selected_package_id was NULL on ~99.5% of shipments and
 * the box deducted ≠ billed ≠ displayed. Both the test path and the real path now
 * persist resolvedPackageId — the SAME value fed to the deduction — so persisted ==
 * deducted by construction. Billing (PS-207) already reads selected_package_id
 * first, so persisted == deducted == billed once the anchor is populated.
 * Forward-only: no backfill of historical NULLs.
 *
 *   npx tsx scripts/ps-221-package-source-of-truth-guard.ts
 */
import { readFileSync } from 'node:fs';

const labels = readFileSync('src/services/labels.ts', 'utf8');
const billingBox = readFileSync('src/services/billing-box-policy.ts', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// 1. The dropped-anchor bug is gone: no persist site writes the raw customPackageId.
check('no label path persists selectedPackageId from raw body.customPackageId',
  !/selectedPackageId:\s*body\.customPackageId/.test(labels));

// 2. Both the test path AND the real path persist the RESOLVED package id.
check('both persist sites use resolvedPackageId (test + real)',
  count(labels, 'selectedPackageId: resolvedPackageId != null ? String(resolvedPackageId) : null') >= 2);

// 3. The deduction is fed the SAME resolvedPackageId → persisted == deducted.
check('inventory/package deduction uses resolvedPackageId',
  count(labels, 'packageId: resolvedPackageId') >= 2);
check('resolvedPackageId is produced by the label package resolver',
  /const resolvedPackageId = await resolveLabelPackageId\(/.test(labels));

// 4. Billing consumes the anchor FIRST (PS-207) → persisted == deducted == billed.
check('billing resolves the shipment box from selected_package_id first',
  billingBox.includes('selectedPackageId') && /resolveShippedPackageId/.test(billingBox));

// 5. Forward-only: this slice adds NO historical backfill / UPDATE of the anchor.
check('no historical backfill UPDATE of selected_package_id introduced',
  !/update\([\s\S]{0,80}selected_package_id|set\(\{[\s\S]{0,80}selectedPackageId/i.test(labels));

// 6. Lockdown citation present on the touched locked surface.
check('labels.ts cites the override for the anchor fix',
  labels.includes('PS-221') && labels.includes('unlock shipped data on 2026-06-13'));

// Self-wiring.
check('package.json exposes test:ps-221-package-source-of-truth',
  /test:ps-221-package-source-of-truth/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-221 package source-of-truth guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-221 package source-of-truth guard');
