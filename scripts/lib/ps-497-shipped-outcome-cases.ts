// PS-497 Slice 2 Release B (S2.7) — the shipped-outcome invariant cases, runner-agnostic. ONE source of case
// logic drives BOTH the real-PG17 integration runner and the PGlite twin (the pack member), so they cannot
// diverge. Under the Release B contract these hold GREEN (they were RED-by-design on stable): a PrepShip
// shipment-backed occurrence with exact lines is deductible and the occurrence executor moves stock exactly
// once; an unavailable receipt is a DURABLE, occurrence-scoped, resolver-consumable review (not the orphaned
// unbounded-growth row); two writers describing ONE physical occurrence collapse to one claim; genuine splits
// stay independent; retries are idempotent; zero/unknown never deducts; external is terminally not_applicable.

export interface ShippedOutcomeClaim {
  id: number;
  status: string;
  sku: string | null;
  quantity: number | null;
  direction: string;
  occurrence_id: number | null;
  canonical_line_identity: string | null;
  idempotency_key: string;
}

export interface ShippedOutcomeHandle {
  // Owner + executor + resolver (the real services under test).
  applyOrderLifecycleCommand(input: Record<string, unknown>): Promise<{ lifecycleEventId: number }>;
  applyOccurrenceClaims(occurrenceId: number): Promise<{ applied: number; alreadyApplied: number; lockedDown: boolean }>;
  resolveOccurrenceReviewClaim(claimId: number, decision: 'pending' | 'not_applicable'): Promise<{ status: string }>;
  // Fixtures.
  newOrder(opts?: { external?: boolean }): Promise<number>;
  newShipment(orderId: number, opts: { labelShipmentId: number | null; source: string }): Promise<number>;
  claimsFor(orderId: number): Promise<ShippedOutcomeClaim[]>;
  ledgerMovementCount(orderId: number): Promise<number>;
}

export interface ShippedOutcomeResult { ok: string[]; red: string[]; fail: string[]; }

const deducts = (claims: ShippedOutcomeClaim[]) => claims.filter((c) => c.direction === 'deduct');

export async function runShippedOutcomeCases(h: ShippedOutcomeHandle): Promise<ShippedOutcomeResult> {
  const ok: string[] = [];
  const red: string[] = [];
  const fail: string[] = [];
  const pass = (m: string) => ok.push(m);
  const bad = (m: string, d: string) => red.push(`${m} — ${d}`);
  const err = (m: string, d: string) => fail.push(`${m} — ${d}`);
  const exact = (lines: unknown[]) => ({ kind: 'exact' as const, evidence: 'exact_shipment' as const, lines });

  // 1. PrepShip shipment-backed + exact evidence -> exactly one occurrence-scoped deductible claim; the
  //    occurrence executor applies exactly one movement.
  try {
    const orderId = await h.newOrder();
    const shipmentId = await h.newShipment(orderId, { labelShipmentId: 555, source: 'shipstation' });
    await h.applyOrderLifecycleCommand({ orderId, shipmentId, commandKey: `exact-${orderId}`, transition: 'shipped', source: 'test', fulfillmentFacts: exact([{ sku: 'SKU-A', quantity: 2, name: 'A' }]) });
    const claims = await h.claimsFor(orderId);
    const pending = deducts(claims).filter((c) => c.status === 'pending');
    const occurrenceId = deducts(claims)[0]?.occurrence_id ?? null;
    if (pending.length === 1 && occurrenceId != null && pending[0]?.canonical_line_identity != null) pass('prepship + exact -> one occurrence-scoped deductible claim');
    else bad('prepship + exact -> one occurrence-scoped deductible claim', JSON.stringify(claims.map((c) => ({ s: c.status, occ: c.occurrence_id }))));
    if (occurrenceId != null) {
      const applied = await h.applyOccurrenceClaims(occurrenceId);
      if (applied.applied === 1 && (await h.ledgerMovementCount(orderId)) === 1) pass('the occurrence executor applies exactly one movement');
      else bad('the occurrence executor applies exactly one movement', `applied=${JSON.stringify(applied)} ledger=${await h.ledgerMovementCount(orderId)}`);
    }
  } catch (e) { err('case 1 prepship exact', String(e).slice(0, 160)); }

  // 2. Unavailable receipt -> a DURABLE occurrence-scoped review (NOT the orphaned unbounded row), consumable
  //    by the resolver to a terminal outcome. The executor moves nothing.
  try {
    const orderId = await h.newOrder();
    const shipmentId = await h.newShipment(orderId, { labelShipmentId: null, source: 'shipstation' });
    const res = await h.applyOrderLifecycleCommand({ orderId, shipmentId, commandKey: `unavail-${orderId}`, transition: 'shipped', source: 'order_sync_status', fulfillmentFacts: { kind: 'unavailable', description: 'shipped without line quantities' } });
    void res;
    const claims = await h.claimsFor(orderId);
    const review = deducts(claims).filter((c) => c.status === 'review');
    const occurrenceScoped = review.length >= 1 && review.every((c) => c.occurrence_id != null && c.canonical_line_identity != null);
    if (occurrenceScoped) {
      const applied = await h.applyOccurrenceClaims(review[0]!.occurrence_id!);
      const consumed = await h.resolveOccurrenceReviewClaim(review[0]!.id, 'not_applicable');
      if (applied.applied === 0 && consumed.status === 'not_applicable') pass('unavailable -> durable occurrence-scoped review, no movement, resolver consumes it to a terminal outcome');
      else bad('unavailable -> durable occurrence-scoped review consumed by the resolver', `applied=${applied.applied} resolved=${consumed.status}`);
    } else {
      bad('unavailable -> durable occurrence-scoped review (not an orphaned unbounded row)', JSON.stringify(claims.map((c) => ({ s: c.status, occ: c.occurrence_id }))));
    }
  } catch (e) { err('case 2 unavailable', String(e).slice(0, 160)); }

  // 3. Two writers describing ONE physical occurrence (same shipment) -> ONE occurrence -> ONE claim.
  try {
    const orderId = await h.newOrder();
    const shipmentId = await h.newShipment(orderId, { labelShipmentId: 999, source: 'shipstation' });
    await h.applyOrderLifecycleCommand({ orderId, shipmentId, commandKey: `occ-a-${orderId}`, transition: 'shipped', source: 'order_sync_status', fulfillmentFacts: exact([{ sku: 'SKU-A', quantity: 2, name: 'A' }]) });
    await h.applyOrderLifecycleCommand({ orderId, shipmentId, commandKey: `occ-b-${orderId}`, transition: 'shipped', source: 'external_shipped_classifier', fulfillmentFacts: exact([{ sku: 'SKU-A', quantity: 2, name: 'A' }]) }).catch(() => undefined);
    const claims = deducts(await h.claimsFor(orderId));
    const occurrences = new Set(claims.map((c) => c.occurrence_id));
    if (claims.length === 1 && occurrences.size === 1) pass('two writers describing one occurrence produce one claim');
    else bad('two writers describing one occurrence produce one claim', `${claims.length} claims across ${occurrences.size} occurrence(s)`);
  } catch (e) { err('case 3 one occurrence', String(e).slice(0, 160)); }

  // 4. Two GENUINE split shipments (distinct provider labels) -> two occurrences -> two independent claims.
  try {
    const orderId = await h.newOrder();
    const s1 = await h.newShipment(orderId, { labelShipmentId: 1001, source: 'shipstation' });
    const s2 = await h.newShipment(orderId, { labelShipmentId: 1002, source: 'shipstation' });
    await h.applyOrderLifecycleCommand({ orderId, shipmentId: s1, commandKey: `split-a-${orderId}`, transition: 'shipped', source: 'test', fulfillmentFacts: exact([{ sku: 'SKU-A', quantity: 1, name: 'A' }]) });
    await h.applyOrderLifecycleCommand({ orderId, shipmentId: s2, commandKey: `split-b-${orderId}`, transition: 'shipped', source: 'test', fulfillmentFacts: exact([{ sku: 'SKU-B', quantity: 1, name: 'B' }]) });
    const claims = deducts(await h.claimsFor(orderId));
    const occurrences = new Set(claims.map((c) => c.occurrence_id));
    if (claims.length === 2 && occurrences.size === 2) pass('two genuine split shipments remain two independent claims');
    else bad('two genuine split shipments remain two independent claims', `${claims.length} claims across ${occurrences.size} occurrence(s)`);
  } catch (e) { err('case 4 split', String(e).slice(0, 160)); }

  // 5. A retry of the SAME writer is idempotent (one claim).
  try {
    const orderId = await h.newOrder();
    const shipmentId = await h.newShipment(orderId, { labelShipmentId: 2001, source: 'shipstation' });
    const key = `retry-${orderId}`;
    await h.applyOrderLifecycleCommand({ orderId, shipmentId, commandKey: key, transition: 'shipped', source: 'test_retry', fulfillmentFacts: exact([{ sku: 'SKU-A', quantity: 2, name: 'A' }]) });
    await h.applyOrderLifecycleCommand({ orderId, shipmentId, commandKey: key, transition: 'shipped', source: 'test_retry', fulfillmentFacts: exact([{ sku: 'SKU-A', quantity: 2, name: 'A' }]) });
    const claims = deducts(await h.claimsFor(orderId));
    if (claims.length === 1) pass('a retry of the same writer is idempotent (one claim)');
    else bad('a retry of the same writer is idempotent (one claim)', `${claims.length} claims`);
  } catch (e) { err('case 5 retry', String(e).slice(0, 160)); }

  // 6. A zero / unknown quantity never becomes deductible work.
  try {
    const orderId = await h.newOrder();
    const shipmentId = await h.newShipment(orderId, { labelShipmentId: 3001, source: 'shipstation' });
    await h.applyOrderLifecycleCommand({ orderId, shipmentId, commandKey: `zero-${orderId}`, transition: 'shipped', source: 'test', fulfillmentFacts: exact([{ sku: 'SKU-A', quantity: 0, name: 'A' }]) });
    const claims = deducts(await h.claimsFor(orderId));
    const deductible = claims.filter((c) => c.status === 'pending');
    if (deductible.length === 0) pass('a zero quantity never becomes deductible work');
    else bad('a zero quantity never becomes deductible work', JSON.stringify(claims.map((c) => c.status)));
  } catch (e) { err('case 6 zero', String(e).slice(0, 160)); }

  // 7. An external (whole-order) fulfillment is terminally not_applicable and never deducts.
  try {
    const orderId = await h.newOrder({ external: true });
    const res = await h.applyOrderLifecycleCommand({ orderId, shipmentId: null, commandKey: `ext-${orderId}`, transition: 'external_shipped', source: 'webhook', fulfillmentFacts: exact([{ sku: 'SKU-A', quantity: 2, name: 'A' }]) });
    const claims = deducts(await h.claimsFor(orderId));
    const notApplicable = claims.filter((c) => c.status === 'not_applicable');
    if (notApplicable.length === 1 && (await h.ledgerMovementCount(orderId)) === 0) pass('external fulfillment -> terminally not_applicable, never deducts');
    else bad('external fulfillment -> terminally not_applicable, never deducts', JSON.stringify(claims.map((c) => c.status)));
    void res;
  } catch (e) { err('case 7 external', String(e).slice(0, 160)); }

  return { ok, red, fail };
}
