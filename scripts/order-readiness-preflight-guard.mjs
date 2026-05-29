import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// PS-035 checkpoint D (Order readiness / preflight before label creation).
// createLabelV2/createLabelFromOrderId must refuse to create a label when the
// order is terminal, when an active label already exists, or when weight /
// ship-to are incomplete. There is no live DB in the offline cert, so this
// guard locks those readiness throw-paths by source presence, and asserts the
// dedicated preflight inspector stays strictly read-only (SELECT-only, no
// postage, no mutation). Static/offline (readFileSync only).

const labels = readFileSync('src/services/labels.ts', 'utf8');
const preflight = readFileSync('scripts/smoke-shipping-preflight.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// 1. Terminal-order refusal: shipped/cancelled orders cannot create a label.
assert(
  labels.includes('Cannot create label for ${order.orderStatus} order'),
  "labels.ts must refuse label creation for shipped/cancelled orders ('Cannot create label for <status> order')",
);

// 2. Duplicate-active-label refusal.
assert(
  labels.includes('Label already exists for this order'),
  'labels.ts must refuse a second label when an active label already exists for the order',
);

// 3. Missing-weight readiness throw.
assert(
  labels.includes('has no weight set'),
  "labels.ts must block label creation when the order has no weight ('has no weight set')",
);

// 4. Incomplete ship-to readiness throw.
assert(
  labels.includes('ship-to missing'),
  "labels.ts must block label creation when ship-to address fields are missing ('ship-to missing ...')",
);

// 5. The dedicated preflight inspector is strictly read-only.
assert(
  /READ_ONLY_PREFLIGHT\s*=\s*true/.test(preflight),
  'smoke-shipping-preflight.ts must keep READ_ONLY_PREFLIGHT = true',
);
assert(
  !/\b(update\s+\w|insert\s+into|delete\s+from)\b/i.test(preflight),
  'smoke-shipping-preflight.ts must be SELECT-only (no UPDATE/INSERT/DELETE)',
);
assert(
  /no real labels|does not create labels|buy postage|marketplace notifications/i.test(preflight),
  'smoke-shipping-preflight.ts must document that it never creates labels / buys postage / notifies marketplaces',
);

// 6. Self-wiring.
assert.equal(
  pkg.scripts?.['test:order-readiness-preflight'],
  'node scripts/order-readiness-preflight-guard.mjs',
  'package.json must expose the order-readiness preflight guard',
);

console.log('PASS order-readiness preflight guard');
