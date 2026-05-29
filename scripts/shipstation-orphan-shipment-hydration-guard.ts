import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyOrphanShipment,
  type OrphanClassification,
} from './reconcile-orphan-shipstation-shipments';

// ---------------------------------------------------------------------------
// PS-046 — Orphan ShipStation shipment hydration/backfill guard.
//
// Two layers:
//   1. Behavioral: every branch of the pure classifier, including the
//      1039/1040/1041 reproduction (shipped SS order never imported as
//      awaiting → orphan shipment with no local order → upstream order found →
//      MUST classify as 'hydrate', i.e. create the missing order + link).
//   2. Static safety: the reconcile script is dry-run-by-default, never
//      deletes shipments / buys labels / notifies marketplaces, reuses the
//      canonical no-duplicate upsert, links by order number, and is registered
//      in package.json.
// ---------------------------------------------------------------------------

function expect(input: Parameters<typeof classifyOrphanShipment>[0], want: OrphanClassification, why: string) {
  assert.equal(classifyOrphanShipment(input), want, why);
}

// 1039/1040/1041 reproduction: orphan shipment, no local order, ShipStation
// still has the shipped order upstream → hydrate (create order + link shipment).
expect(
  { orderNumber: '1039', localOrderCandidates: [], upstream: { found: true, lookupFailed: false } },
  'hydrate',
  'shipped SS order missing locally but present upstream must be hydrated, not left orphaned',
);

// Local order already exists for the number → just link the shipment.
expect(
  {
    orderNumber: '1042',
    localOrderCandidates: [{ id: 7, clientId: 3, externalOrderId: '999' }],
    upstream: { found: false, lookupFailed: false },
  },
  'link_local',
  'a single local order match must link the orphan shipment without hydrating',
);

// No order number → manual/standalone label, never auto-link.
expect(
  { orderNumber: null, localOrderCandidates: [], upstream: { found: false, lookupFailed: false } },
  'manual',
  'an orphan shipment with no order number must be classified manual, never linked',
);
expect(
  { orderNumber: '   ', localOrderCandidates: [], upstream: { found: false, lookupFailed: false } },
  'manual',
  'a blank/whitespace order number must be classified manual',
);

// No local order and no upstream order → genuinely manual.
expect(
  { orderNumber: 'SP-999', localOrderCandidates: [], upstream: { found: false, lookupFailed: false } },
  'manual',
  'no local order and no upstream order means there is nothing to hydrate (manual)',
);

// Multiple local candidates → ambiguous, unsafe to touch.
expect(
  {
    orderNumber: 'DUP',
    localOrderCandidates: [
      { id: 1, clientId: 2, externalOrderId: 'a' },
      { id: 2, clientId: 3, externalOrderId: 'b' },
    ],
    upstream: { found: false, lookupFailed: false },
  },
  'ambiguous',
  'multiple local order candidates for one order number must be ambiguous, not auto-linked',
);

// Upstream lookup failed (no local order) → retryable, not silently manual.
expect(
  { orderNumber: '1040', localOrderCandidates: [], upstream: { found: false, lookupFailed: true } },
  'lookup_failed',
  'an upstream lookup failure must be distinguished from a true no-op so it can be retried',
);

console.log('PASS orphan classification covers hydrate/link_local/manual/ambiguous/lookup_failed');

// ---------------------------------------------------------------------------
// 2. Static safety asserts on the reconcile script.
// ---------------------------------------------------------------------------

const script = readFileSync('scripts/reconcile-orphan-shipstation-shipments.ts', 'utf8');

assert.match(
  script,
  /const apply = hasFlag\('apply'\)/,
  'reconcile script must be dry-run by default and require an explicit --apply flag',
);
assert.match(
  script,
  /upsertNormalizedStoreOrders/,
  'reconcile apply path must hydrate via the canonical upsert (ON CONFLICT — no duplicate orders)',
);
assert.match(
  script,
  /isNull\(shipments\.orderId\)[\s\S]*eq\(shipments\.orderNumber/,
  'reconcile apply path must link orphan shipments by order number where order_id is null',
);
assert.doesNotMatch(
  script,
  /db\.delete\(shipments\)/,
  'reconcile script must never delete shipment rows',
);
assert.doesNotMatch(
  script,
  /buyLabel|purchaseLabel|createLabel|notifyMarketplace|notifySalesChannel/i,
  'reconcile script must never buy labels/postage or notify marketplaces',
);
assert.match(
  script,
  /invokedDirectly/,
  'reconcile main() must be guarded so importing the classifier never triggers DB/network',
);
assert.match(
  script,
  /const linkOnly = hasFlag\('link-only'\)/,
  'reconcile script must support --link-only (fast pure-DB linkage, skipping slow upstream lookups)',
);
assert.match(
  script,
  /if \(linkOnly && localCandidates\.length === 0\)/,
  'link-only mode must skip the upstream ShipStation lookup for orphans with no local order',
);
assert.match(
  script,
  /deductInventoryForOrder\(row, \{ source: 'order_sync_status' \}\)/,
  'hydrated shipped orders must reuse the shared AI-locked inventory deduction path, not a bespoke one',
);

const pkg = readFileSync('package.json', 'utf8');
assert.match(
  pkg,
  /shipstation:orphans:dry-run/,
  'package.json must expose the orphan reconcile dry-run script',
);
assert.match(
  pkg,
  /shipstation:orphans:apply/,
  'package.json must expose the orphan reconcile apply script',
);
assert.match(
  pkg,
  /test:shipstation-orphan-hydration/,
  'package.json must register the orphan hydration guard',
);

console.log('PASS reconcile script is dry-run-default, non-destructive, and registered (PS-046)');
