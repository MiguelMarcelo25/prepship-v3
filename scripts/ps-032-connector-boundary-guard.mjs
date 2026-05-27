import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const AUDIT_DOC = 'docs/ps-032-direct-provider-call-audit.md';

const providerPatterns = [
  /\bssV1Request\b/,
  /\bssRequest\b/,
  /marketplace\.walmartapis\.com/,
  /api\.ebay\.com/,
  /api\.sandbox\.ebay\.com/,
  /onlinetools\.ups\.com/,
  /api\.easypost\.com/,
  /shipp\.to\/api/,
  /api\.shipengine\.com/,
  /api\.usps\.com/,
  /apis\.usps\.com/,
];

const approvedConnectorOwned = new Set([
  'src/connectors/store/walmart.ts',
  'src/connectors/store/ebay.ts',
  'src/connectors/store/shipstation.ts',
  'src/connectors/carrier/shipstation.ts',
  'src/connectors/carrier/ups.ts',
  'src/connectors/carrier/easypost.ts',
  'src/connectors/carrier/shipp.ts',
  'src/connectors/carrier/walmart-shipping.ts',
  'src/lib/shipstation/client.ts',
  'src/lib/shipstation/credentials.ts',
  'src/lib/shipstation/labels.ts',
  'src/lib/shipstation/residential.ts',
  'src/lib/shipstation/v1-client.ts',
]);

const transitionalDebt = new Set([
  'api/_lib/walmart-fees-sync.ts',
  'api/carriers/labels.ts',
  'api/carriers/rates.ts',
  'api/carriers/ups/probe.ts',
  'api/carriers/validate-address.ts',
  'api/carriers/verify.ts',
  'api/carriers/walmart/fees.ts',
  'api/carriers/walmart/probe-carriers.ts',
  'api/cron/sync-walmart-fees.ts',
  'api/oauth/ebay/callback.ts',
  'scripts/probe-rate-scoping.ts',
  'scripts/reconcile-shipstation-awaiting.ts',
  'scripts/recover-marketplace-notifications.ts',
  'scripts/sync-shipstation-products.ts',
  'scripts/verify-ground-saver-fix.ts',
  'src/lib/imported-handlers/carriers-verify.ts',
  'src/lib/imported-handlers/rates-multi.ts',
  'src/routes/clients.ts',
  'src/routes/init.ts',
  'src/routes/locations.ts',
  'src/routes/packages.ts',
  'src/routes/rates.ts',
  'src/services/inventory-enrichment.ts',
  'src/services/labels.ts',
  'src/services/rates.ts',
  'src/services/shipment-sync.ts',
]);

const ignoredFiles = new Set([
  'scripts/api-contracts-guard.mjs',
  'scripts/ebay-confirmation-mocked-guard.ts',
  'scripts/parity/extract.mjs',
  'scripts/ps-032-connector-boundary-guard.mjs',
  'scripts/ps-032-connector-orchestrator-guard.mjs',
]);

function normalize(filePath) {
  return filePath.replace(/\\/g, '/');
}

function walk(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, output);
      continue;
    }
    if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) output.push(normalize(fullPath));
  }
  return output;
}

function hasProviderCall(source) {
  return providerPatterns.some((pattern) => pattern.test(source));
}

assert(existsSync(AUDIT_DOC), `missing ${AUDIT_DOC}`);
const audit = readFileSync(AUDIT_DOC, 'utf8');

for (const file of transitionalDebt) {
  assert(audit.includes(file), `PS-032 audit must document transitional provider call file: ${file}`);
}
for (const file of approvedConnectorOwned) {
  assert(audit.includes(file), `PS-032 audit must document connector-owned provider call file: ${file}`);
}

const scannedFiles = ['src', 'api', 'scripts'].flatMap((root) => walk(root));
const unexpected = [];

for (const file of scannedFiles) {
  if (ignoredFiles.has(file)) continue;
  const source = readFileSync(file, 'utf8');
  if (!hasProviderCall(source)) continue;
  if (approvedConnectorOwned.has(file)) continue;
  if (transitionalDebt.has(file)) continue;
  unexpected.push(file);
}

assert.deepEqual(
  unexpected,
  [],
  [
    'PS-032 provider boundary guard found unclassified direct provider calls.',
    'Move provider API use behind StoreConnector/CarrierConnector, or classify it in docs/ps-032-direct-provider-call-audit.md and this guard as a temporary migration item.',
    ...unexpected.map((file) => ` - ${file}`),
  ].join('\n'),
);

console.log(`PS-032 connector boundary guard passed (${approvedConnectorOwned.size} connector-owned files, ${transitionalDebt.size} transitional debt files).`);
