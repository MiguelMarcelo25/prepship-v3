/**
 * PS-223 guard — packaging rule engine.
 *
 * Unit-tests the PURE core (classifier, signature, matcher) and statically pins
 * the engine contract: the new tables + provenance column exist, the dry-run
 * planner is READ-ONLY, and the engine will never overwrite an operator-set
 * default (source = 'operator').
 *
 *   npx tsx scripts/ps-223-packaging-rule-engine-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  UNCLASSIFIED,
  classifySkuTotals,
  computeRuleKey,
  matchPackingRule,
  signatureHasUnclassified,
  type PackingRule,
} from '../src/lib/packaging-rules-core';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── Pure core unit tests ────────────────────────────────────────────────────
const classMap = new Map<string, string>([['sku-a', 'large'], ['sku-b', 'small']]);

const totals = classifySkuTotals(
  [{ sku: 'SKU-A', quantity: 2 }, { sku: 'sku-b', quantity: 1 }, { sku: 'sku-a', quantity: 1 }],
  classMap,
);
check('classifier sums by class, case-insensitive (large=3, small=1)',
  totals.get('large') === 3 && totals.get('small') === 1);

check('classifier ignores zero/negative qty',
  classifySkuTotals([{ sku: 'sku-a', quantity: 0 }, { sku: 'sku-b', quantity: -5 }], classMap).size === 0);

const unknown = classifySkuTotals([{ sku: 'mystery', quantity: 2 }], classMap);
check('unknown SKU buckets under UNCLASSIFIED', unknown.get(UNCLASSIFIED) === 2);

// computeRuleKey: deterministic, sorted, order-independent, excludes zero counts.
const k1 = computeRuleKey(new Map([['small', 1], ['large', 2]]));
const k2 = computeRuleKey(new Map([['large', 2], ['small', 1]]));
check('ruleKey is deterministic + sorted (large:2|small:1)', k1 === 'large:2|small:1' && k1 === k2);
check('ruleKey excludes zero counts', computeRuleKey(new Map([['large', 0], ['small', 1]])) === 'small:1');
check('empty totals → empty ruleKey', computeRuleKey(new Map()) === '');

// count BOUNDARY: different counts → different keys (no accidental collapse).
check('count boundary: large:1 != large:2',
  computeRuleKey(new Map([['large', 1]])) !== computeRuleKey(new Map([['large', 2]])));

check('signatureHasUnclassified detects unknowns',
  signatureHasUnclassified(`${UNCLASSIFIED}:1|large:2`) && !signatureHasUnclassified('large:2'));

// matcher: exact match, priority tiebreak, empty key → null.
const rules: PackingRule[] = [
  { ruleKey: 'large:2|small:1', packageId: 121, packageCode: null, priority: 0 },
  { ruleKey: 'large:2|small:1', packageId: 999, packageCode: null, priority: 5 },
  { ruleKey: 'large:1', packageId: 124, packageCode: null, priority: 0 },
];
check('matcher exact-matches the signature', matchPackingRule('large:1', rules)?.packageId === 124);
check('matcher highest priority wins on tie', matchPackingRule('large:2|small:1', rules)?.packageId === 999);
check('matcher returns null for no match', matchPackingRule('nope:9', rules) === null);
check('matcher returns null for empty key', matchPackingRule('', rules) === null);

// ── Static contract ─────────────────────────────────────────────────────────
const migration = read('drizzle/0047_packaging_rule_engine.sql');
check('migration creates client_sku_classes', /create table if not exists client_sku_classes/i.test(migration));
check('migration creates client_packing_rules', /create table if not exists client_packing_rules/i.test(migration));
check('migration adds combo-defaults provenance column',
  /alter table client_combo_package_defaults add column if not exists source/i.test(migration));
check('migration enables RLS with no policy (project model)',
  /client_sku_classes enable row level security/i.test(migration) && !/create policy/i.test(migration));

const schema = read('src/db/schema/packaging-rules.ts');
check('schema defines both tables', schema.includes("'client_sku_classes'") && schema.includes("'client_packing_rules'"));
// `source` is added by the migration + the runtime ensure, and is INTENTIONALLY
// not modeled in drizzle (bare select() would emit it and 500 before migrate).
const combo = read('src/db/schema/client-combo-package-defaults.ts');
check('combo-defaults source column is NOT modeled in drizzle (bare-select safety)',
  !/source:\s*text\(/.test(combo) && combo.includes('NOT modeled here'));

const service = read('src/services/packaging-rules.ts');
check('service has the lazy ensure-schema', service.includes('export async function ensurePackagingRulesSchema'));
check('service ensure adds the combo-defaults source column (raw SQL)',
  /ALTER TABLE client_combo_package_defaults ADD COLUMN IF NOT EXISTS source/i.test(service));
check('service exposes the read-only planner', service.includes('export async function planPackagingForAwaitingOrders'));
// Read-only: no data mutation (DDL CREATE/ALTER in ensure is allowed; data writes are not).
check('planner/service performs NO data writes (insert/update set/delete)',
  !/insert\s+into/i.test(service) && !/\bupdate\s+\w+\s+set\b/i.test(service) && !/delete\s+from/i.test(service));
check('engine protects operator-set defaults (skip:operator-default)',
  service.includes("operatorSet.has") && service.includes("'skip:operator-default'") && service.includes("source = 'operator'"));
check('planner is awaiting-only (PS-082 gate)', service.includes("order_status = 'awaiting_shipment'"));

const dryRun = read('scripts/ps-223-packaging-rules-dry-run.ts');
check('dry-run script exists + read-only (no writes)',
  dryRun.length > 0 && !/insert\s+into|\bupdate\s+\w+\s+set\b|delete\s+from/i.test(dryRun));

const pkg = read('package.json');
check('package.json wires the dry-run', /ps-223:rules:dry-run/.test(pkg));
check('package.json wires test:ps-223-packaging-rule-engine', /test:ps-223-packaging-rule-engine/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-223 packaging rule engine guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-223 packaging rule engine guard');
