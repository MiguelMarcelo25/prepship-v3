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
const consumption = readFileSync('src/services/package-consumption.ts', 'utf8');
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
  count(labels, 'selectedPackageId: resolvedPackageId') >= 2 &&
  labels.includes('consumeOutboundPackageInTransaction({'));
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

// ── Slice 2: unified resolver — label-time selection follows the canonical source ──
const resolver = (() => { try { return readFileSync('src/services/package-resolution.ts', 'utf8'); } catch { return ''; } })();
check('unified resolver service exists', resolver.includes('export async function resolveOrderLabelPackageId('));
check('precedence #1: operator pick (customPackageId) wins',
  /toPositiveInt\(args\.customPackageId\)/.test(resolver));
check('precedence #2: the order canonical selected_package_id is consulted',
  /orderOverrides\.selectedPackageId/.test(resolver) && /resolvePackageRef/.test(resolver));
check('canonical ref resolves by packages.id OR package_code',
  /eq\(packages\.id/.test(resolver) && /eq\(packages\.packageCode/.test(resolver));
check('precedence #3: safe exact-dims fallback', /DIMS_TOLERANCE = 0\.001/.test(resolver) && /findPackageByDims/.test(resolver));
// Slice 3: auto-provision is DARK by default — writes gated behind the flag.
check('auto-provision flag reads env (off when unset)',
  /export function isPackageAutoProvisionEnabled/.test(resolver) && /PACKAGE_AUTO_PROVISION/.test(resolver));
check('auto-provision writes are gated behind the flag',
  /if \(isPackageAutoProvisionEnabled\(\) &&/.test(resolver));
check('auto-provision find-or-creates the box + saves the combo default',
  /findOrCreatePackageForDims/.test(resolver) && /saveComboPackageDefault\(/.test(resolver));
check('labels.ts delegates to the unified resolver (no inline dims-guess)',
  labels.includes('resolveOrderLabelPackageSelection(args)') &&
  resolver.includes('resolveOutboundPackageSelection({') &&
  resolver.includes("matchedBy: 'auto_provision'") &&
  consumption.includes('resolveOutboundPackageSelection') &&
  !/const tol = 0\.1;/.test(labels));
check('labels.ts threads orderId into the resolver',
  /resolveLabelPackageId\(\{[\s\S]*?orderId: body\.orderId/.test(labels));

// Slice 3 dry-run: read-only readiness baseline before flipping the flag.
const dryRun = (() => { try { return readFileSync('scripts/ps-221-auto-provision-dry-run.ts', 'utf8'); } catch { return ''; } })();
check('auto-provision dry-run exists', dryRun.length > 0);
check('dry-run is read-only (counts only, no writes)',
  !/db\.insert\(|db\.update\(|db\.delete\(|saveComboPackageDefault|\.insert\(/.test(dryRun));
check('package.json wires the auto-provision dry-run', /ps-221-auto-provision-dry-run/.test(pkg));

// Self-wiring.
check('package.json exposes test:ps-221-package-source-of-truth',
  /test:ps-221-package-source-of-truth/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-221 package source-of-truth guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-221 package source-of-truth guard');
