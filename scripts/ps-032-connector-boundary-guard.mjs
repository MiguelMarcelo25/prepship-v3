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
  /apis\.fedex\.com/,
  /shipp\.to\/api/,
  /api\.shipengine\.com/,
  /api\.usps\.com/,
  /apis\.usps\.com/,
  /api\.amazon\.com/,
  /sellingpartnerapi-na\.amazon\.com/,
];

const approvedConnectorOwned = new Set([
  'src/connectors/store/walmart.ts',
  'src/connectors/store/walmart-fees.ts',
  'src/connectors/store/ebay.ts',
  'src/connectors/store/shipstation.ts',
  'src/connectors/carrier/shipstation.ts',
  'src/connectors/tracking/shipstation.ts',
  'src/connectors/carrier/ups.ts',
  'src/connectors/carrier/easypost.ts',
  'src/connectors/carrier/shipp.ts',
  'src/connectors/carrier/walmart-shipping.ts',
  'src/connectors/carrier/fedex.ts',
  'src/connectors/carrier/usps.ts',
  'src/connectors/carrier/shipengine.ts',
  'src/connectors/carrier/ebay-shipping.ts',
  'src/connectors/carrier/amazon-shipping.ts',
  'src/connectors/carrier/credential-verification.ts',
  'src/lib/shipstation/client.ts',
  'src/lib/shipstation/credentials.ts',
  'src/lib/shipstation/labels.ts',
  'src/lib/shipstation/residential.ts',
  'src/lib/shipstation/v1-client.ts',
]);

const transitionalDebt = new Set([
  'scripts/backfill-shipstation-fulfillments.ts',
  'scripts/probe-batched-rate-estimate.ts',
  'scripts/reconcile-external-shipped-orders.ts',
]);

const transitionalSafetyRequirements = {
  'scripts/backfill-shipstation-fulfillments.ts': [
    /Dry-run unless `--apply`/,
    /INSERT-ONLY/,
    /never creates labels\/postage/,
    /never\s+notifies marketplaces/,
    /only runs when invoked directly/,
  ],
  'scripts/probe-batched-rate-estimate.ts': [
    /Live, non-purchase go\/no-go probe/,
    /Calls only GET \/v2\/carriers and POST \/v2\/rates\/estimate/,
    /Never creates labels, updates orders, writes shipments, or notifies marketplaces/,
    /Requires both `--live` and an explicit credential source selection/,
    /refusing provider calls without --live/,
  ],
  'scripts/reconcile-external-shipped-orders.ts': [
    /dry-run by default/,
    /never creates\/voids labels/,
    /never buys postage/,
    /never notifies marketplaces/,
    /runs only when invoked directly/,
  ],
};

const sourcePinOnlyFiles = new Set([
  'scripts/ps-200-walmart-fees-worker-cron-cutover-guard.ts',
  'scripts/ps-265-sync-run-budget-guard.ts',
  'scripts/ps-339-ebay-api-testing-certification-guard.ts',
  'scripts/ps-406-duplicate-label-audit-guard.ts',
  // PS-432 reads connector source to pin the upstream pre-read boundary; it
  // imports no provider function and executes no network request.
  'scripts/ps-432-sync-fulfillment-resilience-guard.ts',
]);

const mockedProviderCertificationFiles = new Set([
  // PS-440 executes the ShipStation client against a replaced global fetch
  // to prove total-deadline behavior. It cannot reach a provider.
  'scripts/ps-440-connection-safety-guard.ts',
]);

const stubbedJoinedProofFiles = new Set([
  // PS-494 joined end-to-end proof (Hermes finding 5): executes the real browse and label
  // entrypoints against a throwaway database with globalThis.fetch REPLACED before any src
  // import. Provider URLs appear only in its stub allow-list and captured-body assertions;
  // any outbound URL outside that allow-list throws and fails the run. Enforced below with
  // the same marker discipline as the PS-440 class, so the file cannot silently lose its
  // offline boundary while keeping this classification.
  'scripts/ps-494-joined-origin-pg17.ts',
]);

const ignoredFiles = new Set([
  'scripts/api-contracts-guard.mjs',
  'scripts/ebay-confirmation-mocked-guard.ts',
  'scripts/parity/extract.mjs',
  'scripts/ps-032-connector-boundary-guard.mjs',
  'scripts/ps-032-connector-orchestrator-guard.mjs',
  // References ssRequest/v2 tracking ONLY inside source-pin regexes (no provider calls).
  'scripts/shipment-tracking-retirement-guard.ts',
  // PS-289 guards: ssRequest/ssV1Request appear ONLY inside NEGATIVE assertion
  // regexes that prove the multi-package adapter does NOT call ShipStation
  // directly. They are guard scripts, not provider callers.
  'scripts/ps-289-multi-package-closeout-guard.ts',
  'scripts/ps-289-multi-package-shipstation-adapter-guard.ts',
  // Static source-pin guards: provider URLs appear only in assertions that
  // verify their connector remains the owner. These files make no API calls.
  ...sourcePinOnlyFiles,
  ...mockedProviderCertificationFiles,
  ...stubbedJoinedProofFiles,
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
  const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
  assert(audit.includes(file), `PS-032 audit must document transitional provider call file: ${file}`);
  assert(
    existsSync(file) && hasProviderCall(source),
    `PS-032 transitional debt file no longer has direct provider calls and should be removed: ${file}`,
  );
  for (const requirement of transitionalSafetyRequirements[file] ?? []) {
    assert(requirement.test(source), `PS-032 transitional debt file is missing required safety marker ${requirement}: ${file}`);
  }
}
for (const file of approvedConnectorOwned) {
  assert(audit.includes(file), `PS-032 audit must document connector-owned provider call file: ${file}`);
}
for (const file of sourcePinOnlyFiles) {
  const source = readFileSync(file, 'utf8');
  assert(/\breadFileSync\b/.test(source), `PS-032 source-pin guard must remain static: ${file}`);
  assert(
    !/\b(?:ssRequest|ssV1Request|timedFetch|fetch)\s*(?:<[^>]+>)?\s*\(/.test(source),
    `PS-032 source-pin guard contains an executable provider call: ${file}`,
  );
}
for (const file of mockedProviderCertificationFiles) {
  const source = readFileSync(file, 'utf8');
  assert(
    source.includes('All provider calls are mocked') &&
      source.includes('const originalFetch = globalThis.fetch;') &&
      source.includes('globalThis.fetch = originalFetch;') &&
      /ssV1Request\('\/offline'/.test(source),
    `PS-032 mocked provider certification lost its offline fetch boundary: ${file}`,
  );
}
for (const file of stubbedJoinedProofFiles) {
  const source = readFileSync(file, 'utf8');
  assert(
    source.includes('globalThis.fetch = (') &&
      source.includes('unexpected outbound URL') &&
      source.includes('No provider contacted. No postage.'),
    `PS-032 stubbed joined-proof file lost its offline fetch boundary: ${file}`,
  );
  assert(audit.includes(file), `PS-032 audit must document stubbed joined-proof file: ${file}`);
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
