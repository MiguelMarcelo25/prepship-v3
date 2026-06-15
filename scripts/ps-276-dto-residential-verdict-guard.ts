/**
 * PS-276 (slice 4) guard — the order DTO exposes the BACKEND's resolved residential verdict.
 *
 * Pins: (1) buildCanonicalOrderModel resolves residential through the SAME evidence owner
 * (buildResidentialEvidenceFromOrder) + classifier (classifyShippingAddress) + money-safe
 * policy (residentialForShipping) the rate path uses, so recipient.residentialClassification
 * equals the rate fingerprint r= bit by construction; (2) it exposes the MONEY-SAFE verdict
 * (residentialForShipping), NOT result.classification — they differ for the company-heuristic
 * case, and exposing the raw classification would diverge from the rate; (3) source +
 * confidence are exposed for the resi/comm tag; (4) the FE DTO type declares the fields.
 *
 *   npx tsx scripts/ps-276-dto-residential-verdict-guard.ts
 */
import { readFileSync } from 'node:fs';
import { buildResidentialEvidenceFromOrder } from '../src/services/shipping-workflow/residential-evidence';
import {
  classifyShippingAddress,
  residentialForShipping,
} from '../src/services/shipping-workflow/address-classification';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const shipTo = { name: null, company: null, city: 'Brazoria', state: 'TX', postalCode: '77422', country: 'US' };
// The exact mapping buildCanonicalOrderModel performs.
function dtoVerdict(input: { rawShipTo: unknown; manualOverrideResidential: unknown; shipToName?: string | null }) {
  const ev = buildResidentialEvidenceFromOrder(input);
  const result = classifyShippingAddress({
    orderId: undefined,
    clientId: null,
    storeId: null,
    shipTo: { ...shipTo, company: ev.toCompany, name: ev.toName },
    manualOverrideResidential: ev.manualOverrideResidential,
    sourceResidential: ev.sourceResidential,
  });
  return {
    classification: (residentialForShipping(result) ? 'residential' : 'commercial') as 'residential' | 'commercial',
    source: result.source,
    confidence: result.confidence,
    rawClassification: result.classification,
  };
}

// ── 1. The verdict is the MONEY-SAFE value (matches the rate r=), not result.classification ──
const heuristic = dtoVerdict({ rawShipTo: { company: 'ACME LLC' }, manualOverrideResidential: null });
check('company-heuristic -> DTO verdict residential (money-safe), even though raw classification is commercial',
  heuristic.classification === 'residential' && heuristic.rawClassification === 'commercial');
check('company-heuristic -> confidence is heuristic (tag can flag it)', heuristic.confidence === 'heuristic');

const commercialOverride = dtoVerdict({ rawShipTo: { residential: true }, manualOverrideResidential: false });
check('manual commercial override -> DTO verdict commercial + source manual_override',
  commercialOverride.classification === 'commercial' && commercialOverride.source === 'manual_override');

const sourceResidential = dtoVerdict({ rawShipTo: { residential: true }, manualOverrideResidential: null });
check('source residential -> DTO verdict residential + confidence source',
  sourceResidential.classification === 'residential' && sourceResidential.confidence === 'source');

const fallback = dtoVerdict({ rawShipTo: {}, manualOverrideResidential: null });
check('no evidence -> DTO verdict residential (fallback, money-safe)',
  fallback.classification === 'residential' && fallback.confidence === 'fallback');

// ── 2. orders.ts wires the shared owner + classifier + money-safe policy ──────
const orders = readFileSync('src/routes/orders.ts', 'utf8');
check('orders.ts imports the shared evidence owner + classifier + money-safe policy',
  /buildResidentialEvidenceFromOrder/.test(orders) &&
    /classifyShippingAddress/.test(orders) &&
    /residentialForShipping/.test(orders));
check('buildCanonicalOrderModel resolves the verdict via the shared owner',
  /const residentialEvidence = buildResidentialEvidenceFromOrder\(\{/.test(orders) &&
    /const residentialResult = classifyShippingAddress\(\{/.test(orders) &&
    /const residentialResolved = residentialForShipping\(residentialResult\)/.test(orders));
check('recipient exposes the MONEY-SAFE verdict (residentialResolved), NOT result.classification',
  /residentialClassification: \(residentialResolved \? 'residential' : 'commercial'\)/.test(orders) &&
    !/residentialClassification: residentialResult\.classification/.test(orders));
check('recipient exposes source + confidence for the resi/comm tag',
  /residentialSource: residentialResult\.source/.test(orders) &&
    /residentialConfidence: residentialResult\.confidence/.test(orders));

// ── 3. FE DTO type declares the fields (slice 3 consumes them) ────────────────
const feType = readFileSync('web/src/types/orders.ts', 'utf8');
check('FE order DTO type declares residentialClassification/source/confidence',
  /residentialClassification\?: 'residential' \| 'commercial'/.test(feType) &&
    /residentialSource\?: string/.test(feType) &&
    /residentialConfidence\?: string/.test(feType));

// ── 4. package.json wiring ────────────────────────────────────────────────────
check('package.json wires test:ps-276-dto-residential-verdict',
  /test:ps-276-dto-residential-verdict/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-276 DTO residential verdict guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-276 DTO residential verdict guard');
