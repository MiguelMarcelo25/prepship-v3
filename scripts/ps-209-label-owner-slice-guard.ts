/**
 * PS-209 guard (first slice) — v4 /labels is the ONLY label purchase owner.
 *
 * The legacy Vercel function api/carriers/labels.ts was a complete second
 * purchase pipeline and — because vercel.json's rewrite exclusions keep
 * /api/carriers/* served locally — it stayed REACHABLE in production after
 * PS-202 moved all callers to v4. It is now a no-import 410
 * (LEGACY_LABEL_ENDPOINT_RETIRED). This guard fails if purchase capability
 * creeps back into that module or any client code starts calling the legacy
 * path again.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const legacy = read('api/carriers/labels.ts');
const pkg = read('package.json');

// ── The legacy module is a blocked, import-free stub ───────────────────────
assert.ok(legacy.includes('LEGACY_LABEL_ENDPOINT_RETIRED') && legacy.includes('410'),
  'the legacy endpoint must return the retired 410');
assert.ok(!/^import /m.test(legacy) && !legacy.includes('await import('),
  'the stub must have ZERO imports — no purchase capability can exist in it');
for (const banned of [
  'createCarrierLabel',
  'persistDirectCarrierLabel',
  'confirmStoreShipment',
  'processFulfillmentOutboxOnce',
  'postgres(',
  'INSERT INTO shipments',
]) {
  assert.ok(!legacy.includes(banned),
    `legacy endpoint must not contain purchase machinery: ${banned}`);
}

// ── No client code calls the legacy path ────────────────────────────────────
// Dozens of files legitimately NAME the path in comments documenting the old
// architecture — the pin is on CALL shapes: a quoted URL literal containing
// the legacy path in the API client layers. (The PS-202 guard separately pins
// that createLabel posts ONLY to v4 /labels.)
const urlLiteral = /['"`][^'"`\n]*carriers\/labels[^'"`\n]*['"`]/;
for (const file of ['web/src/lib/v2-apiClient.ts', 'web/src/lib/v2-apiClient/shared.ts', 'web/src/lib/api.ts']) {
  // Strip comment lines first — comments legitimately document the retired
  // path; only CODE-side quoted URLs are the violation.
  const codeOnly = read(file)
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
  assert.ok(!urlLiteral.test(codeOnly),
    `${file} must not carry a legacy carriers/labels URL literal`);
}

// ── The canonical owner is intact ───────────────────────────────────────────
const labelsSvc = read('src/services/labels.ts');
assert.ok(labelsSvc.includes('export async function createLabelV2'),
  'createLabelV2 stays the canonical purchase owner');
assert.ok(labelsSvc.includes('assertLabelPurchaseRateSelection'),
  'the selected-rate proof gate stays at the owner');

// The audit deliverable exists alongside the slice.
assert.ok(read('docs/engineering/ps-209-shipping-architecture-audit.md').includes('Label-purchase owner map'),
  'the PS-209 audit document must exist');

// npm wiring.
assert.ok(pkg.includes('"test:ps-209-label-owner-slice"'),
  'guard must be wired into package.json');

console.log('PASS ps-209 label owner slice guard');
