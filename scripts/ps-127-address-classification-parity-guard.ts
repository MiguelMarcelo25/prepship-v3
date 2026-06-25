/**
 * PS-127 guard — backend-owned residential/commercial classifier priority + nuance.
 * Pure logic; no DB, no network, no postage, no labels.
 *
 *   npx tsx scripts/ps-127-address-classification-parity-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  classifyShippingAddress,
  residentialForShipping,
} from '../src/services/shipping-workflow/address-classification';
import { residentialFromRequestFingerprint } from '../src/services/shipping-workflow/rate-fingerprint';

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

// 9. residentialForShipping policy: commercial ONLY on trusted evidence; residential-safe otherwise
{
  const trustedCommercial = cls({ sourceResidential: false });
  check('trusted source commercial -> rate commercial', residentialForShipping(trustedCommercial), false);
  const manualCommercial = cls({ manualOverrideResidential: false });
  check('manual override commercial -> rate commercial', residentialForShipping(manualCommercial), false);
  const validatedCommercial = cls({ addressValidation: { business: 'Y' } });
  check('validated business commercial -> rate commercial', residentialForShipping(validatedCommercial), false);
  const weakCommercial = cls({ shipTo: { company: 'Acme Corp', name: 'Jane Doe' } });
  check('weak company heuristic commercial -> rate RESIDENTIAL-safe (never under-quote)', residentialForShipping(weakCommercial), true);
  const fallback = cls({ shipTo: { name: 'Jane Doe' } });
  check('fallback -> rate residential', residentialForShipping(fallback), true);
  const trustedResidential = cls({ sourceResidential: true });
  check('trusted residential -> rate residential', residentialForShipping(trustedResidential), true);
}

// 10. residentialFromRequestFingerprint parses r=1/r=0 for the label parity guard
{
  check('fingerprint r=1 -> residential true', residentialFromRequestFingerprint('v=1|z=11364|r=1|cl=4'), true);
  check('fingerprint r=0 -> commercial false', residentialFromRequestFingerprint('v=1|z=11364|r=0|cl=4'), false);
  check('fingerprint without r= -> null', residentialFromRequestFingerprint('v=1|z=11364|cl=4'), null);
  check('empty fingerprint -> null', residentialFromRequestFingerprint(''), null);
}

// 11. Static: backend rate resolver delegates to the classifier (no blanket residential default)
{
  const rates = readFileSync('src/services/rates.ts', 'utf8');
  check('resolveRateInput calls classifyShippingAddress', /classifyShippingAddress\(/.test(rates), true);
  check('resolveRateInput applies residentialForShipping policy', /residentialForShipping\(/.test(rates), true);
  check('resolveRateInput no longer defaults residential via input.residential !== false', /residential:\s*input\.residential\s*!==\s*false/.test(rates), false);
  check('direct carriers receive the resolved residential', /residential:\s*input\.residential,/.test(rates), true);
}

// 12. Static: label purchase is the authoritative parity point
{
  const labels = readFileSync('src/services/labels.ts', 'utf8');
  check('createLabelV2 classifies the order address', /classifyShippingAddress\(/.test(labels), true);
  check('createLabelV2 stamps the label residential', /shipTo\.residential\s*=\s*labelResidential/.test(labels), true);
  check('createLabelV2 enforces a rate/label residential mismatch block', /RATE_LABEL_RESIDENTIAL_MISMATCH/.test(labels), true);

  const ssLabels = readFileSync('src/lib/shipstation/labels.ts', 'utf8');
  check('label toAddress emits address_residential_indicator', /address_residential_indicator/.test(ssLabels), true);
}

// 13. Static: direct carriers honor residential; frontend no longer hardcodes residential:true in rate calls
{
  const shipengine = readFileSync('src/connectors/carrier/shipengine.ts', 'utf8');
  check('shipengine ship-to honors residential (not hardcoded yes)', /residential === false \? 'no' : 'yes'/.test(shipengine), true);
  const shipp = readFileSync('src/connectors/carrier/shipp.ts', 'utf8');
  check('shipp ship-to honors residential (not hardcoded yes)', /residential === false \? 'no' : 'yes'/.test(shipp), true);

  // PS-317: residentialForRate moved to ./orders/best-rate/rate-request — include it so the delegation pins resolve.
  const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8') + readFileSync('web/src/components/Views/orders/best-rate/rate-request.ts', 'utf8');
  check('OrdersView defines residentialForRate helper', /function residentialForRate\(/.test(ordersView), true);
  check('OrdersView no longer hardcodes residential: true', /residential:\s*true,/.test(ordersView), false);
  // PS-280: residentialForRate moved to the shared FE owner web/src/lib/residential-for-rate;
  // OrdersView + RateBrowserModal both DELEGATE to it (one FE owner, no drift). The forward-only
  // property is unchanged — read the BACKEND verdict (PS-276 recipient.residentialClassification),
  // own no raw-field derivation, default residential-safe — but it lives in ONE shared rule now.
  check('OrdersView delegates residentialForRate to the shared rule',
    /residentialForRate as residentialForRateRule/.test(ordersView) &&
      /return residentialForRateRule\(order\)/.test(ordersView), true);
  {
    const rule = readFileSync('web/src/lib/residential-for-rate.ts', 'utf8');
    const helperStart = rule.indexOf('export function residentialForRate(');
    const helperEnd = rule.indexOf('\n}', helperStart);
    const helperBody = helperStart >= 0 ? rule.slice(helperStart, helperEnd) : '';
    check('shared rule defers to the backend residential verdict (reads residentialClassification)',
      /residentialClassification \?\? order\?\.canonicalOrder\?\.recipient\?\.residentialClassification/.test(helperBody), true);
    check('shared rule no longer re-derives from the raw source flag (thin client)',
      /sourceResidential/.test(helperBody), false);
    check('shared rule no longer re-derives from raw shipTo (thin client)',
      /rawShipTo|raw\?\.shipTo/.test(helperBody), false);
    check('shared rule defaults to residential (return true fallback)',
      /return true\s*$/.test(helperBody.trimEnd()), true);
  }

  const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
  check('RateBrowserModal no longer hardcodes residential: true', /residential:\s*true,/.test(modal), false);
}

if (failures > 0) {
  console.error(`\nFAIL PS-127 address classification parity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-127 address classification parity guard');
