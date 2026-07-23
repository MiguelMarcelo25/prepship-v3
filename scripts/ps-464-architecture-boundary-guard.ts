/**
 * PS-464 executable architecture boundary owner.
 *
 * Offline/static only: parses source with the TypeScript compiler API. It does
 * not import product runtime, call providers, touch a database, buy postage,
 * notify marketplaces, or mutate shipped/cancelled records.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  readSources,
  scanFrontendPrivateImports,
  scanFrontendSemanticAuthority,
  scanRoutePersistenceWrites,
  type FrontendPrivateImport,
  type FrontendSemanticAuthority,
  type RoutePersistenceWrite,
  type SourceInput,
} from './lib/architecture-boundary-analyzer';
import {
  FRONTEND_IMPORT_EXCEPTIONS,
  FRONTEND_SEMANTIC_EXCEPTIONS,
  ROUTE_PERSISTENCE_EXCEPTIONS,
} from './ps-464-architecture-boundary-policy';

const inventoryOnly = process.argv.includes('--inventory');
let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail, null, 2)}`}`);
}

function fixture(name: string, path: string): SourceInput {
  return { path: name, content: readFileSync(path, 'utf8') };
}

function importKey(finding: Pick<FrontendPrivateImport, 'sourcePath' | 'targetPath'>): string {
  return `${finding.sourcePath} -> ${finding.targetPath}`;
}

function semanticKey(
  finding: Pick<FrontendSemanticAuthority, 'sourcePath' | 'site' | 'rule'>,
): string {
  return `${finding.sourcePath}#${finding.site}:${finding.rule}`;
}

function routeSiteCounts(findings: RoutePersistenceWrite[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.routeSite] = (counts[finding.routeSite] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function sameRecord(left: Record<string, number>, right: Record<string, number>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentHead(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '<git-unavailable>';
  }
}

const negativeSemantic = scanFrontendSemanticAuthority([
  fixture(
    'web/src/__fixtures__/negative-renamed-authority.ts',
    'scripts/fixtures/ps-464/negative-renamed-authority.ts.fixture',
  ),
]);
const negativeRules = new Set(negativeSemantic.map((finding) => finding.rule));
for (const expected of [
  'rate-ranking',
  'selected-rate-proof-minting',
  'label-provider-selection',
  'inventory-authority',
  'billing-finalization',
  'auth-scope-status-lock',
  'provider-capability-routing',
  'money-authority',
] as const) {
  check(`negative fixture catches renamed ${expected}`, negativeRules.has(expected), negativeSemantic);
}

const positiveSemantic = scanFrontendSemanticAuthority([
  fixture(
    'web/src/__fixtures__/positive-display.ts',
    'scripts/fixtures/ps-464/positive-display.ts.fixture',
  ),
  fixture(
    'src/adapters/__fixtures__/positive-provider-adapter.ts',
    'scripts/fixtures/ps-464/positive-provider-adapter.ts.fixture',
  ),
]);
check('positive display/DTO and provider-adapter fixtures remain allowed', positiveSemantic.length === 0, positiveSemantic);

const negativeRoute = scanRoutePersistenceWrites([
  fixture('src/routes/__fixtures__/negative-fat-route.ts', 'scripts/fixtures/ps-464/negative-fat-route.ts.fixture'),
]);
const positiveRoute = scanRoutePersistenceWrites([
  fixture('src/routes/__fixtures__/positive-thin-route.ts', 'scripts/fixtures/ps-464/positive-thin-route.ts.fixture'),
]);
check('negative route fixture catches route-local persistence', negativeRoute.length === 1, negativeRoute);
check('positive thin-route fixture remains allowed', positiveRoute.length === 0, positiveRoute);

const frontendSources = readSources('web/src');
const routeSources = readSources('src/routes');
const privateImports = scanFrontendPrivateImports(frontendSources);
const semanticAuthority = scanFrontendSemanticAuthority(frontendSources);
const routeWrites = scanRoutePersistenceWrites(routeSources);
const routeWritesByPath = new Map<string, RoutePersistenceWrite[]>();
for (const finding of routeWrites) {
  const existing = routeWritesByPath.get(finding.sourcePath) ?? [];
  existing.push(finding);
  routeWritesByPath.set(finding.sourcePath, existing);
}

console.log(`\nPS-464 current-head boundary inventory (${currentHead()})`);
console.log(`frontend backend-private imports: ${privateImports.length} across ${new Set(privateImports.map((item) => item.sourcePath)).size} files`);
console.log(`route-local persistence writes: ${routeWrites.length} across ${routeWritesByPath.size} files`);
console.log(`frontend semantic authority sites: ${semanticAuthority.length}`);

if (inventoryOnly) {
  console.log('\nFRONTEND_PRIVATE_IMPORTS');
  console.log(JSON.stringify(privateImports, null, 2));
  console.log('\nROUTE_PERSISTENCE');
  console.log(JSON.stringify([...routeWritesByPath.entries()].map(([sourcePath, findings]) => ({
    sourcePath,
    count: findings.length,
    routeSites: routeSiteCounts(findings),
    findings,
  })), null, 2));
  console.log('\nFRONTEND_SEMANTIC_AUTHORITY');
  console.log(JSON.stringify(semanticAuthority, null, 2));
  if (failures > 0) process.exit(1);
  process.exit(0);
}

for (const exception of [
  ...FRONTEND_IMPORT_EXCEPTIONS,
  ...ROUTE_PERSISTENCE_EXCEPTIONS,
  ...FRONTEND_SEMANTIC_EXCEPTIONS,
]) {
  check(`${exception.ownerCard} exception ${'sourcePath' in exception ? exception.sourcePath : '<unknown>'} has a review reason`, exception.reason.trim().length >= 20);
}

const actualImportKeys = new Set(privateImports.map(importKey));
const allowedImportKeys = new Set(FRONTEND_IMPORT_EXCEPTIONS.map(importKey));
check('frontend private-import exceptions are unique', allowedImportKeys.size === FRONTEND_IMPORT_EXCEPTIONS.length);
check('no new frontend import reaches a backend-private module',
  [...actualImportKeys].every((key) => allowedImportKeys.has(key)),
  [...actualImportKeys].filter((key) => !allowedImportKeys.has(key)));
check('frontend private-import allowlist shrinks when debt is removed',
  [...allowedImportKeys].every((key) => actualImportKeys.has(key)),
  [...allowedImportKeys].filter((key) => !actualImportKeys.has(key)));

const allowedRoutePaths = new Set(ROUTE_PERSISTENCE_EXCEPTIONS.map((exception) => exception.sourcePath));
check('route persistence exceptions are unique', allowedRoutePaths.size === ROUTE_PERSISTENCE_EXCEPTIONS.length);
check('no new route file owns direct persistence',
  [...routeWritesByPath.keys()].every((path) => allowedRoutePaths.has(path)),
  [...routeWritesByPath.keys()].filter((path) => !allowedRoutePaths.has(path)));
for (const exception of ROUTE_PERSISTENCE_EXCEPTIONS) {
  const actual = routeWritesByPath.get(exception.sourcePath) ?? [];
  check(`${exception.sourcePath} direct-write count matches shrinking ratchet`,
    actual.length === exception.maxDirectWrites,
    { expected: exception.maxDirectWrites, actual: actual.length });
  check(`${exception.sourcePath} direct-write route sites match reviewed debt`,
    sameRecord(routeSiteCounts(actual), exception.routeSites),
    { expected: exception.routeSites, actual: routeSiteCounts(actual) });
}

const actualSemanticKeys = new Set(semanticAuthority.map(semanticKey));
const allowedSemanticKeys = new Set(FRONTEND_SEMANTIC_EXCEPTIONS.map(semanticKey));
check('frontend semantic exceptions are unique', allowedSemanticKeys.size === FRONTEND_SEMANTIC_EXCEPTIONS.length);
check('no new frontend site owns backend-critical authority',
  [...actualSemanticKeys].every((key) => allowedSemanticKeys.has(key)),
  [...actualSemanticKeys].filter((key) => !allowedSemanticKeys.has(key)));
check('frontend semantic allowlist shrinks when debt is removed',
  [...allowedSemanticKeys].every((key) => actualSemanticKeys.has(key)),
  [...allowedSemanticKeys].filter((key) => !actualSemanticKeys.has(key)));

console.log('\nReviewed exception ownership');
console.table(FRONTEND_IMPORT_EXCEPTIONS.map((item) => ({
  layer: 'frontend import',
  site: importKey(item),
  owner: item.ownerCard,
  reason: item.reason,
})));
console.table(ROUTE_PERSISTENCE_EXCEPTIONS.map((item) => ({
  layer: 'route persistence',
  site: item.sourcePath,
  count: item.maxDirectWrites,
  owner: item.ownerCard,
  reason: item.reason,
})));
console.table(FRONTEND_SEMANTIC_EXCEPTIONS.map((item) => ({
  layer: 'frontend authority',
  site: semanticKey(item),
  owner: item.ownerCard,
  reason: item.reason,
})));

if (failures > 0) {
  console.error(`\nPS-464 architecture boundary guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-464 architecture boundary guard passed.');
