/**
 * PS-441 closure guard for the 42 verified frontend source-of-truth findings.
 *
 * Offline only: reads repository evidence and exercises a pure frontend cache
 * helper. It does not connect to a database/provider, buy postage, create a
 * label, notify a marketplace, or mutate shipped/cancelled production data.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  billingEditDraftForRow,
  rememberBillingEditDraft,
  type BillingEditDraft,
} from '../web/src/components/Views/billing-edit-draft-cache';
import type { BillingDetailDto } from '../web/src/components/Views/billing-parity';

type Finding = {
  id: string;
  severity: 'high' | 'medium';
  rule: string;
  unsafeOwner: string;
  canonicalOwner: string;
  entryPoint: string;
  disposition: 'deleted' | 'delegated' | 'forbidden';
  callers: string;
  proof: string;
};

const read = (path: string): string => readFileSync(path, 'utf8');
const confirmed = JSON.parse(read('docs/ps-tickets/PS-433/sot-confirmed.json')) as {
  taskId: string;
  source: { implementationSha: string };
  findings: Finding[];
};
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const scripts = packageJson.scripts ?? {};

assert.equal(confirmed.taskId, 'PS-433');
assert.equal(confirmed.source.implementationSha, '49b913fc35b4564571d9bd0f1ce814714a17b0fc');
assert.equal(confirmed.findings.length, 42, 'all 42 migrated/reclassified findings must remain reviewable');
assert.equal(new Set(confirmed.findings.map((finding) => finding.id)).size, 42, 'finding ids must be unique');
assert.equal(confirmed.findings.filter((finding) => finding.severity === 'high').length, 15);
assert.equal(confirmed.findings.filter((finding) => finding.severity === 'medium').length, 27);
assert.ok(confirmed.findings.every((finding) =>
  finding.rule.trim() &&
  finding.unsafeOwner.trim() &&
  finding.canonicalOwner.trim() &&
  finding.entryPoint.trim() &&
  finding.callers.trim() &&
  ['deleted', 'delegated', 'forbidden'].includes(finding.disposition) &&
  finding.proof.startsWith('npm run '),
));

for (const proof of new Set(confirmed.findings.map((finding) => finding.proof))) {
  const script = proof.slice('npm run '.length).trim();
  assert.equal(typeof scripts[script], 'string', `finding proof must resolve to a package script: ${script}`);
}

const draft = (packageCost: string): BillingEditDraft => ({
  pickPack: '2.50',
  additional: '0.00',
  packageCost,
  shipping: '7.95',
  packageId: '12',
  reason: 'Operator correction',
});
const firstOrder: BillingDetailDto = { orderId: 2115, packageId: 12, packageName: '9x6x3' };
const secondOrderSameBox: BillingDetailDto = { orderId: 2112, packageId: 12, packageName: '9x6x3' };
const cache = rememberBillingEditDraft({}, firstOrder, draft('0.99'));

assert.equal(
  billingEditDraftForRow(cache, firstOrder, draft('0.00')).packageCost,
  '0.99',
  'an unsaved draft may be restored only for the exact order',
);
assert.equal(
  billingEditDraftForRow(cache, secondOrderSameBox, draft('0.00')).packageCost,
  '0.00',
  'a box-cost draft must never become cross-order money truth',
);

const draftCacheSource = read('web/src/components/Views/billing-edit-draft-cache.ts');
const billingViewSource = read('web/src/components/Views/BillingView.tsx');
assert.doesNotMatch(`${draftCacheSource}\n${billingViewSource}`, /carryFrom|sameBillingBox/);

const evidence = read('docs/ps-tickets/PS-441.md');
for (const required of [
  '49b913fc35b4564571d9bd0f1ce814714a17b0fc',
  'PS-433/sot-confirmed.json',
  'src/services/rates.ts',
  'src/services/billing-invoice-totals.ts',
  'src/services/reporting-window-presets.ts',
  'src/services/billing-box-cost-bulk.ts',
]) {
  assert.match(evidence, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

assert.equal(
  scripts['test:ps-441-sot-migration'],
  'npm run test:ps-433-frontend-source-of-truth && npm run test:billing-edit-draft-cache && tsx scripts/ps-441-sot-migration-guard.ts',
);

console.log('PS-441 source-of-truth migration guard passed.');
