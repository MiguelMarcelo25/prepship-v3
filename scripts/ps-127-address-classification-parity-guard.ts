/**
 * PS-127 guard — backend-owned residential/commercial classifier priority + nuance.
 * Pure logic; no DB, no network, no postage, no labels.
 *
 *   npx tsx scripts/ps-127-address-classification-parity-guard.ts
 */
import { readFileSync } from 'node:fs';
import { classifyShippingAddress } from '../src/services/shipping-workflow/address-classification';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures += 1;
    console.error(`FAIL ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
const cls = (i: Parameters<typeof classifyShippingAddress>[0]) => classifyShippingAddress(i);

// 1. Manual override wins over source flag (both directions)
{
  const r = cls({ manualOverrideResidential: false, sourceResidential: true });
  check('manual commercial override beats source residential', [r.classification, r.source], ['commercial', 'manual_override']);
  const r2 = cls({ manualOverrideResidential: true, sourceResidential: false });
  check('manual residential override beats source commercial', [r2.classification, r2.source], ['residential', 'manual_override']);
}

// 2. Trusted source flag classifies when no override
{
  const r = cls({ sourceResidential: false });
  check('source residential=false -> commercial (source)', [r.classification, r.confidence], ['commercial', 'source']);
  const r2 = cls({ sourceResidential: true });
  check('source residential=true -> residential (source)', [r2.classification, r2.confidence], ['residential', 'source']);
}

// 3. USPS business validation evidence classifies commercial when no manual/source
{
  const r = cls({ addressValidation: { business: 'Y' } });
  check('USPS business=Y -> commercial (validated)', [r.classification, r.source], ['commercial', 'address_validation']);
  const r2 = cls({ addressValidation: { business: 'N' } });
  check('USPS business=N -> residential (validated)', [r2.classification, r2.source], ['residential', 'address_validation']);
}

// 4. NUANCE: ZIP+4 / DPV / carrier route alone do NOT classify commercial
{
  const r = cls({ shipTo: { postalCode: '11364-2081' }, addressValidation: { zipPlus4: '11364-2081', dpvConfirmation: 'Y', carrierRoute: 'C001' } });
  check('ZIP+4/DPV/route alone -> still fallback residential', [r.classification, r.source], ['residential', 'fallback_residential']);
  check('ZIP+4 captured as evidence', r.evidence.zipPlus4, '11364-2081');
}

// 5. Company-name heuristic is WEAK (only when no trusted evidence), and source beats it
{
  const r = cls({ shipTo: { company: 'Acme Corp', name: 'Jane Doe' } });
  check('company present, no other evidence -> commercial (heuristic)', [r.classification, r.confidence], ['commercial', 'heuristic']);
  const r2 = cls({ shipTo: { company: 'Acme Corp', name: 'Jane Doe' }, sourceResidential: true });
  check('source residential beats company heuristic', [r2.classification, r2.source], ['residential', 'shipstation_source']);
  const r3 = cls({ shipTo: { company: 'Jane Doe', name: 'Jane Doe' } });
  check('company == recipient name is ignored -> fallback', [r3.classification, r3.source], ['residential', 'fallback_residential']);
}

// 6. Unknown falls back to residential
{
  const r = cls({ shipTo: { name: 'Jane Doe', city: 'Queens' } });
  check('unknown -> fallback residential', [r.residential, r.source, r.confidence], [true, 'fallback_residential', 'fallback']);
}

// 7. provider marker (explicit) is trusted as source-level
{
  const r = cls({ providerMarker: { classification: 'commercial', provider: 'shipstation' }, sourceResidential: true });
  check('explicit provider marker beats source flag', [r.classification, r.source], ['commercial', 'provider_marker']);
}

// 8. Static: classifier is the canonical owner (single source file present)
{
  const src = readFileSync('src/services/shipping-workflow/address-classification.ts', 'utf8');
  check('classifier reuses PS-126 postal helper (no competing zip logic)', /normalizeShippingPostalCode/.test(src), true);
  check('classifier never classifies commercial from ZIP+4 alone (nuance noted)', /never classify commercial from ZIP\+4 alone/i.test(src), true);
}

if (failures > 0) {
  console.error(`\nFAIL PS-127 address classification parity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-127 address classification parity guard');
