#!/usr/bin/env tsx
/**
 * PS-502 — mutation matrix for the replacement contract guard.
 *
 * The guard is large and mostly green-by-construction, which is exactly the condition under
 * which a check quietly stops defending anything. Each mutation reintroduces a defect the
 * card names and requires the guard to go red AT THE CHECK THAT OWNS IT.
 *
 * Scope matches the guard's: the unlocked slice only. Nothing here touches shipped data, a
 * label, inventory or billing rows — the mutations edit pure modules and one migration-free
 * lifecycle table.
 *
 * Run on a clean tree. Files are restored in a finally block.
 */
import { runMutationMatrix, type Mutation } from './lib/mutation-matrix';

const FINGERPRINT = 'src/services/replacement-source-line-fingerprint.ts';
const REFERENCE = 'src/services/replacement-reference.ts';
const STATE_MACHINE = 'src/services/replacement-state-machine.ts';
const ALLOWANCE = 'src/services/replacement-allowance.ts';
const BILLABILITY = 'src/services/replacement-billability.ts';
const CREATE = 'src/services/replacement-create-command.ts';
const SHIPMENT = 'src/services/replacement-shipment-command.ts';
const SCHEMA = 'src/db/schema/replacements.ts';
const BILLING_SCHEMA = 'src/db/schema/billing.ts';
const APPLIER = 'scripts/apply-ps-502-replacement-schema.ts';
const LIFECYCLE = 'src/services/replacement-lifecycle-command.ts';
const PURCHASE_REQ = 'src/services/replacement-purchase-request.ts';
const LABEL_BUY = 'src/services/replacement-label-purchase-command.ts';
const LABEL_VOID = 'src/services/replacement-label-void-command.ts';
const SHIPPED = 'src/services/replacement-shipped-command.ts';
const BILL_PLAN = 'src/services/replacement-billing-planner.ts';
const BILL_WRITE = 'src/services/replacement-billing-writer.ts';
const SWEEP = 'src/services/billing-outbound-sweep.ts';
const POLICY = 'src/services/billing-finalization-policy.ts';
const FOLD = 'src/services/billing-replacement-finalized-fold.ts';
const GENERATOR = 'src/services/billing.ts';
const NO_CHARGE = 'src/services/billing-cancelled-no-charge.ts';
const ROUTE = 'src/routes/replacements.ts';
const DIAGNOSTICS = 'src/services/replacement-diagnostics.ts';
const MAIN = 'src/main.ts';
const SCHEMA_PROBE = 'src/services/replacement-schema-readiness.ts';
const MIGRATION_WORKFLOW = '.github/workflows/render-one-off-migration-ps502.yml';
const FENCE = 'src/services/replacement-customer-money.ts';
const PLANNER = 'src/services/replacement-billing-planner.ts';
const INVOICE_TOTALS = 'src/services/billing-invoice-totals.ts';
const HOLD = 'src/services/replacement-original-order-hold.ts';
const ORDER_LIFECYCLE = 'src/services/order-lifecycle-command.ts';
const UPSTREAM = 'src/services/fulfillment/upstream-reconcile.ts';
const ENV = 'src/lib/env.ts';
const PG17 = 'scripts/ps-502-replacement-concurrency-pg17.ts';

const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    defect: 'quantity drops out of the fingerprint — the card\'s duplicate-SKU worst case reopens',
    file: FINGERPRINT,
    find: '    normalizeQuantity(facts.originalOrderedQuantity),',
    replace: '    null,',
    expect: 'DUPLICATE-SKU REORDER is caught (the card\'s worst case)',
  },
  {
    id: 'M2',
    defect: 'the format version leaves the tuple, so a layout change becomes indistinguishable from drift',
    file: FINGERPRINT,
    find: '    REPLACEMENT_FINGERPRINT_VERSION,',
    replace: '',
    expect: 'the format is versioned, so a layout change is deliberate not silent',
  },
  {
    id: 'M3',
    defect: 'delimiter-joined encoding replaces JSON, letting two lines forge one fingerprint',
    file: FINGERPRINT,
    find: /return JSON\.stringify\(\[([\s\S]*?)\]\);/,
    replace: "return [$1].join('|');",
    expect: 'a separator inside a field cannot forge another line\'s fingerprint',
  },
  {
    id: 'M4',
    defect: 'SKU comparison becomes case-sensitive, so a case change reads as product drift',
    file: FINGERPRINT,
    find: "  return typeof value === 'string' ? value.trim().toLowerCase() : '';",
    replace: "  return typeof value === 'string' ? value.trim() : '';",
    expect: 'SKU case and surrounding space are not drift',
  },
  {
    id: 'M5',
    defect: 'numeric quantity is no longer canonicalised, so "2.000" and 2 diverge',
    file: FINGERPRINT,
    find: "  const parsed = typeof value === 'number' ? value : Number(String(value).trim());",
    replace: '  const parsed = value as number;',
    expect: 'numeric quantity representations are one value ("2" = 2 = "2.000")',
  },
  {
    id: 'M6',
    defect: 'review is shown only the first other home of the frozen SKU',
    file: FINGERPRINT,
    find: '    .sort((a, b) => a - b);',
    replace: '    .slice(0, 1).sort((a, b) => a - b);',
    expect: 'review can tell "this line moved" from "this product is gone"',
  },
  {
    id: 'M7',
    defect: 'the first replacement is emitted as -1, creating a second spelling of one identity',
    file: REFERENCE,
    find: '  return sequence === 1',
    replace: '  return false',
    expect: 'the first replacement is the BARE form, never -1',
  },
  {
    id: 'M8',
    defect: 'allocation counts references instead of taking max, so a cancelled gap is reused',
    file: REFERENCE,
    find: '    if (parsed.sequence > highest) highest = parsed.sequence;',
    replace: '    highest += 1;',
    expect: 'a GAP is never reused (a cancelled replacement keeps its reference)',
  },
  {
    id: 'M9',
    defect: 'the parser accepts the non-canonical -1 spelling',
    file: REFERENCE,
    find: '  if (sequence < 2) return null;',
    replace: '  if (sequence < 0) return null;',
    expect: '"1321-REPLACE-1" is rejected as a reference',
  },
  {
    id: 'M10',
    defect: 'another order\'s references advance this order\'s sequence',
    file: REFERENCE,
    find: '    if (!parsed || parsed.orderNumber !== trimmed) continue;',
    replace: '    if (!parsed) continue;',
    expect: 'another order\'s references do not advance this order',
  },
  {
    id: 'M11',
    defect: 'label_failed -> shipped becomes legal — goods ship with no label',
    file: STATE_MACHINE,
    find: "  label_failed: ['review', 'approved', 'label_created', 'cancelled'],",
    replace: "  label_failed: ['review', 'approved', 'label_created', 'cancelled', 'shipped'],",
    expect: 'label_failed -> shipped is ILLEGAL',
  },
  {
    id: 'M12',
    defect: 'a never-shipped status consumes allowance, so a cancelled request reduces the cap',
    file: ALLOWANCE,
    find: "const ALLOWANCE_CONSUMING_STATUSES: readonly ReplacementStatus[] = ['shipped', 'completed'];",
    replace: "const ALLOWANCE_CONSUMING_STATUSES: readonly ReplacementStatus[] = ['shipped', 'completed', 'approved'];",
    expect: 'approved does NOT consume allowance',
  },
  {
    id: 'M13',
    defect: 'a post-ship review stops consuming, so the same units can go out twice',
    file: ALLOWANCE,
    find: "  return row.status === 'review' && row.shippedAt != null;",
    replace: '  return false;',
    expect: 'a POST-ship review DOES consume (it shipped, then drifted)',
  },
  {
    id: 'M14',
    defect: 'the cap stops aggregating on the frozen coordinate, so a reorder resets it',
    file: ALLOWANCE,
    find: '    if (row.sourceLineFingerprint !== input.sourceLineFingerprint) continue;',
    replace: '    if (false) continue;',
    expect: 'the cap aggregates on the FROZEN coordinate, not on whatever sits there now',
  },
  {
    id: 'M15',
    defect: 'an over-ship override no longer needs a reason — an unattributable claim',
    file: ALLOWANCE,
    find: "  if (override?.hasOverridePermission && reason !== '') {",
    replace: '  if (override?.hasOverridePermission) {',
    expect: 'an override requires a reason, not just the permission',
  },
  {
    id: 'M16',
    defect: 'operator liability stops forcing non-billable — the client is charged for our mistake',
    file: BILLABILITY,
    find: "  return owner === 'operator' ? false : null;",
    replace: '  return null;',
    expect: 'operator liability FORCES non-billable, even for finance',
  },
  {
    id: 'M17',
    defect: 'billability stays editable past label_created, after postage is committed',
    file: BILLABILITY,
    find: '  if (!BILLABILITY_EDITABLE_STATUSES.includes(change.status)) {',
    replace: '  if (false) {',
    expect: 'billability is FROZEN from label_created onward',
  },
  {
    id: 'M18',
    defect: 'one permission suffices, so replacements:billing alone can move money',
    file: BILLABILITY,
    find: '    || !hasPermission(change.actor, FINANCIALS_WRITE_PERMISSION)',
    replace: '',
    expect: 'replacements:billing alone is not enough — financials:write is also required',
  },
  {
    id: 'M19',
    defect: 'a migration column is dropped from Drizzle, making it invisible to every typed query',
    file: SCHEMA,
    find: "    sourceLineFingerprint: text('source_line_fingerprint').notNull(),",
    replace: '',
    expect: 'replacement_items: every migration column is declared in Drizzle',
  },
  {
    id: 'M20',
    defect: 'Drizzle declares a column the database lacks — a bare select() then 500s the route',
    file: SCHEMA,
    find: '    quantity: integer().notNull(),',
    replace: "    quantity: integer().notNull(),\n    phantomColumn: text('phantom_column'),",
    expect: 'replacement_items: Drizzle declares NO column the migration lacks',
  },
  {
    id: 'M21',
    defect: 'the schema stops mirroring 0097\'s ON DELETE, disagreeing with the deployed database',
    file: BILLING_SCHEMA,
    // Regex, not a literal: billing.ts is tracked with CRLF (core.autocrlf=true), so a
    // literal "\n" here matches nothing and the mutation silently goes stale.
    find: /replacementId: integer\('replacement_id'\)\.references\(\(\) => replacements\.id, \{\r?\n(\s*)onDelete: 'restrict',/,
    replace: "replacementId: integer('replacement_id').references(() => replacements.id, {\n$1onDelete: 'set null',",
    expect: 'both replacement financial FKs are ON DELETE RESTRICT',
  },
  {
    id: 'M22',
    defect: 'the order-scoped lock is dropped — two concurrent creates both read the same allowance',
    file: CREATE,
    find: /await tx\.execute\(sql`select pg_advisory_xact_lock[^`]*`\);/,
    replace: '',
    expect: 'an order-scoped advisory lock is taken FIRST',
  },
  {
    id: 'M23',
    defect: 'the lock class collides with billing\'s client lock',
    file: CREATE,
    find: 'const REPLACEMENT_ORDER_LOCK_CLASS = 36423;',
    replace: 'const REPLACEMENT_ORDER_LOCK_CLASS = 36421;',
    expect: 'the lock class is distinct from billing\'s',
  },
  {
    id: 'M24',
    defect: 'a retried create errors instead of returning the replacement it already made',
    file: CREATE,
    find: '      return { replacement: existing, created: false };',
    replace: "      throw new ReplacementCreateError('REPLACEMENT_NO_ITEMS', 'duplicate', 409);",
    expect: 'a matching repeated key returns the EXISTING replacement rather than erroring',
  },
  {
    id: 'M25',
    defect: 'the cumulative cap is no longer consulted before creating',
    file: CREATE,
    find: '      const verdict = evaluateReplacementAllowance({',
    replace: '      const verdict = { allowed: true, viaOverride: false } as any; const skipped = ({',
    expect: 'the allowance is evaluated BEFORE the insert',
  },
  {
    id: 'M26',
    defect: 'billability authority is no longer consulted, so an operator can set it',
    file: CREATE,
    find: '    const billability = evaluateBillabilityChange({',
    replace: '    const billability = { allowed: true, billable: false } as any; const skippedB = ({',
    expect: 'billability is evaluated BEFORE the insert',
  },
  {
    id: 'M27',
    defect: 'the reference is string-built, filing the SECOND replacement under the first\'s identity',
    file: CREATE,
    find: '    const reference = nextReplacementReference(',
    replace: '    const reference = `${order.orderNumber}-REPLACE`; const unusedRef = (',
    expect: 'the reference is ALLOCATED, never string-built',
  },
  {
    id: 'M28',
    defect: 'create starts writing a shipment row, so a rejected request has already moved goods',
    file: CREATE,
    find: '    await tx.insert(replacementItems).values(',
    replace: '    await tx.insert(shipments).values({} as any);\n    await tx.insert(replacementItems).values(',
    expect: 'create writes NO shipments row',
  },
  {
    id: 'M29',
    defect: 'drift is no longer re-resolved before a shipment exists',
    file: SHIPMENT,
    find: '    const finding = await findFrozenLineDrift(tx, replacement);',
    replace: '    const finding = null as unknown as null;',
    expect: 'drift is re-resolved BEFORE the shipment is inserted',
  },
  {
    id: 'M30',
    defect: 'the drift review throws instead of committing — the operator sees 409 forever and nothing is recorded',
    file: SHIPMENT,
    find: '      return { drifted: true, orderLineIndex: item.orderLineIndex, reference: replacement.reference };',
    replace: "      throw new ReplacementShipmentError(REPLACEMENT_ERROR_CODES.SOURCE_LINE_CHANGED, 'drift', 409);",
    expect: 'a drift review is COMMITTED, then reported',
  },
  {
    id: 'M31',
    defect: 'the state_version guard is dropped, so the two-transaction gap goes unchecked',
    file: SHIPMENT,
    find: '        eq(replacements.stateVersion, before.stateVersion),',
    replace: '',
    expect: 'the link is guarded by status AND state_version',
  },
  {
    id: 'M32',
    defect: 'a retry mints a SECOND shipment for one replacement',
    file: SHIPMENT,
    find: '  if (outcome.existingShipmentId != null) {',
    replace: '  if (false) {',
    expect: 'an already-attached replacement returns its existing shipment',
  },
  {
    id: 'M33',
    defect: 'the replacement shipment claims the original order number — reads as a duplicate label',
    file: SHIPMENT,
    find: '        orderNumber: before.reference,',
    replace: '        orderNumber: String(before.orderId),',
    expect: 'the shipment carries the REPLACEMENT reference, not the original order number',
  },
  {
    id: 'M34',
    defect: 'the outbound re-ship is flagged as a return, inverting its direction in every report',
    file: SHIPMENT,
    find: "        source: 'replacement',",
    replace: "        source: 'replacement',\n        isReturn: true,",
    expect: 'a replacement is outbound — isReturn is never set',
  },
  // ── Hermes correctness findings, at 07f8a9bb ────────────────────────────────
  {
    id: 'M35',
    defect: 'quantity is truncated again — 1.9 silently becomes 1 and one unit ships',
    file: CREATE,
    find: '    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {',
    replace: '    if (false) {',
    expect: 'a fractional or non-positive quantity is a coded 400, not a database CHECK error',
  },
  {
    id: 'M36',
    defect: 'duplicate line coordinates reach the unique index instead of a coded 400',
    file: CREATE,
    find: '    if (seenIndexes.has(item.orderLineIndex)) {',
    replace: '    if (false) {',
    expect: 'duplicate line coordinates are rejected before the transaction',
  },
  {
    id: 'M37',
    defect: 'an arbitrary reason is accepted against the frozen vocabulary',
    file: CREATE,
    find: '  if (!REPLACEMENT_REASONS.includes(input.reason as ReplacementReason)) {',
    replace: '  if (false) {',
    expect: 'the frozen reason vocabulary is enforced server-side',
  },
  {
    id: 'M38',
    defect: 'the whole-request signature stops being compared — a reused key returns the WRONG replacement',
    file: CREATE,
    find: '      if (existing.requestSignature !== requestSignature) {',
    replace: '      if (false) {',
    expect: 'idempotency binds the WHOLE request, not just its items',
  },
  {
    id: 'M39',
    defect: 'the billability reason is validated and then discarded again',
    file: CREATE,
    find: "        eventType: 'replacement_billability_set',",
    replace: "        eventType: 'replacement_requested_again',",
    expect: 'the billability reason is RECORDED, not just validated',
  },
  {
    id: 'M40',
    // RE-TARGETED (PS-502 item 11). The drift review's predicate moved out of the shipment
    // command and into enterReplacementReview, so the defect is reintroduced THERE. Its owner
    // is now the per-site check, and that is the point of the pair: M47 kills applyTransition's
    // copy of this line and M40 kills the review writer's. A file-wide presence check would
    // catch M47 and MISS M40 — so the two together are what prove that check walks every
    // update site rather than settling for one match somewhere in the file.
    defect: 'the shared review writer drops its expected-status predicate',
    file: LIFECYCLE,
    // Anchored on the row-count check below it, which makes the block unique to the review
    // writer: applyTransition's copy of the same predicate is followed by moved.length, not by
    // reviewed.length, so this block cannot match it.
    find: /      eq\(replacements\.status, before\.status\),\n      eq\(replacements\.stateVersion, before\.stateVersion\),\n    \)\)\n    \.returning\(\);\n\n  if \(reviewed\.length === 0\) \{/,
    replace: "      eq(replacements.stateVersion, before.stateVersion),\n    ))\n    .returning();\n\n  if (reviewed.length === 0) {",
    expect: 'EVERY update to replacements is guarded on status AND state_version',
  },
  {
    id: 'M41',
    // RE-TARGETED (PS-502 item 11): the row-count check moved into the shared writer with the
    // update it guards. The name reviewed appears nowhere else in the lifecycle file, so the two-space
    // form targets enterReplacementReview and nothing else.
    defect: 'a lost drift race still appends an event describing a transition that never happened',
    file: LIFECYCLE,
    find: '  if (reviewed.length === 0) {',
    replace: '  if (false) {',
    expect: 'a lost drift race appends NO event',
  },
  {
    id: 'M42',
    defect: 'an authorized client-liability FALSE loses its reason again',
    file: CREATE,
    find: "    if (input.liabilityOwner === 'client') {",
    replace: '    if (billability.billable) {',
    expect: 'an authorized client-liability decision is recorded whether TRUE or FALSE',
  },
  {
    id: 'M43',
    defect: 'a behaviourally significant field drops out of the request signature',
    file: CREATE,
    find: '    billabilityReason: normalizeReason(input.billabilityReason),',
    replace: '',
    expect: 'the signature covers every behaviourally significant field',
  },
  {
    id: 'M44',
    defect: 'the production migration lane goes stale again — a migration the code needs is not deployed',
    file: APPLIER,
    find: "const SQL_0099 = 'drizzle/0099_ps502_replacement_request_signature.sql';",
    replace: '',
    expect: 'the runner applies 0099_ps502_replacement_request_signature.sql',
  },  {
    id: 'M45',
    defect: 'the concurrency lane drops to a single backend and proves nothing',
    file: PG17,
    find: 'max: 8, prepare: false',
    replace: 'max: 1, prepare: false',
    expect: 'the pool opens MULTIPLE backends',
  },  {
    id: 'M46',
    defect: 'a transition stops checking its row count and records a move that never happened',
    file: LIFECYCLE,
    find: '  if (moved.length === 0) {',
    replace: '  if (false) {',
    expect: 'a zero-row transition is a coded 409 and appends NO event',
  },
  {
    id: 'M47',
    defect: 'the expected-status predicate is dropped from every transition',
    file: LIFECYCLE,
    find: '      eq(replacements.status, before.status),',
    replace: '',
    expect: 'EVERY update to replacements is guarded on status AND state_version',
  },
  {
    id: 'M48',
    defect: 'a remap no longer needs the override capability',
    file: LIFECYCLE,
    find: '  if (!input.actor.permissions.includes(REPLACEMENT_OVERRIDE_PERMISSION)) {',
    replace: '  if (false) {',
    expect: 'a remap requires the dedicated override capability and a reason',
  },
  {
    id: 'M49',
    defect: 'a remap stops re-running the allowance against its new coordinate',
    file: LIFECYCLE,
    find: '    const verdict = evaluateReplacementAllowance({',
    replace: '    const verdict = { allowed: true } as any; const skipped = ({',
    expect: 'a remap re-runs the allowance against the NEW coordinate',
  },  {
    id: 'M50',
    defect: 'a policy default is accepted while its DJ decision is still unfrozen',
    file: PURCHASE_REQ,
    find: '    if (!FROZEN_DECISIONS[decision.key]) {',
    replace: '    if (false) {',
    expect: 'a POLICY DEFAULT for address is refused while its decision is unfrozen',
  },
  {
    id: 'M51',
    defect: 'a decision is frozen in code rather than by DJ on the card',
    file: PURCHASE_REQ,
    find: '  address: false,',
    replace: '  address: true,',
    expect: 'every DJ decision governing a default is still UNFROZEN',
  },
  {
    id: 'M52',
    defect: 'an override no longer needs an actor and a reason',
    file: PURCHASE_REQ,
    find: '  if (!chosenBy || !reason) {',
    replace: '  if (false) {',
    expect: 'an override of address without an ACTOR is refused',
  },
  {
    id: 'M53',
    defect: 'internal cost data is allowed to travel in a provider request',
    file: PURCHASE_REQ,
    find: '    if (FORBIDDEN_COST_KEYS.includes(key)) {',
    replace: '    if (false) {',
    expect: 'internal cost data cannot travel in a provider request',
  },
  {
    id: 'M54',
    defect: 'the package fingerprint stops covering weight, so a retry can buy a different parcel',
    file: PURCHASE_REQ,
    find: '      request.package.packageId, request.package.weightOz,',
    replace: '      request.package.packageId,',
    expect: 'the fingerprint covers the values a purchase depends on',
  },  {
    id: 'M55',
    defect: 'the label feature flag defaults ON',
    file: ENV,
    find: '  REPLACEMENTS_LABEL_ENABLED: booleanFlag(false),',
    replace: '  REPLACEMENTS_LABEL_ENABLED: booleanFlag(true),',
    expect: 'the feature flag is server-authoritative and DEFAULT OFF',
  },
  {
    id: 'M56',
    defect: 'the durable intent is written AFTER dispatch, so a crash leaves no proof',
    file: LABEL_BUY,
    find: '    const [intent] = await tx.insert(replacementLabelPurchaseIntents).values({',
    replace: '    const [intent] = await tx.insert(replacements).values({',
    expect: 'the durable intent is committed BEFORE dispatch',
  },
  {
    id: 'M57',
    defect: 'an unresolved intent no longer blocks a further dispatch',
    file: LABEL_BUY,
    find: '    if (unresolved) {',
    replace: '    if (false) {',
    expect: 'an unresolved intent BLOCKS a further dispatch',
  },
  {
    id: 'M58',
    defect: 'drift after dispatch discards the purchased label instead of reviewing',
    file: LABEL_BUY,
    find: "        eventType: 'replacement_label_purchased_into_review',",
    replace: "        eventType: 'replacement_label_discarded',",
    expect: 'post-dispatch drift PRESERVES the label and reviews',
  },  {
    id: 'M59',
    defect: 'an unconfirmed void is recorded as voided while the label is still live',
    file: LABEL_VOID,
    find: '  if (!result.voided) {',
    replace: '    if (false) {',
    expect: 'an UNCONFIRMED void is never recorded as voided',
  },
  {
    id: 'M60',
    defect: 'a repeated void sends a second destructive call',
    file: LABEL_VOID,
    find: "    if (intent.voidState === 'voided') {",
    replace: '    if (false) {',
    expect: 'an already-voided label sends no second destructive call',
  },
  {
    id: 'M61',
    defect: 'the void capability check is removed',
    file: LABEL_VOID,
    find: '  if (!input.actor.permissions.includes(REPLACEMENT_LABEL_PERMISSION)) {',
    replace: '  if (false) {',
    expect: 'BOTH provider-reaching commands require the label capability and a reason',
  },  {
    id: 'M62',
    defect: 'the inventory kill switch stops blocking, so stock moves with no ledger entry',
    file: SHIPPED,
    find: '    if (env.INVENTORY_AUTO_DEDUCT !== true) {',
    replace: '    if (false) {',
    expect: 'the inventory kill switch is checked BEFORE any write',
  },
  {
    id: 'M63',
    defect: 'the ledger key drops the replacement item, collapsing duplicate-SKU lines',
    file: SHIPPED,
    find: '    `:item:${input.replacementItemId}:inventory:${input.inventoryId}:ship`;',
    replace: '    `:inventory:${input.inventoryId}:ship`;',
    expect: 'inventory identity is replacement- and ITEM-scoped',
  },
  {
    id: 'M64',
    defect: 'a billable replacement can ship with no billing lines',
    file: SHIPPED,
    find: '    if (replacement.billable) {',
    replace: '    if (false) {',
    expect: 'a billable replacement CANNOT ship without billing lines',
  },
  {
    id: 'M65',
    defect: 'an unresolved package is silently skipped',
    file: SHIPPED,
    find: '    if (!input.consumePackage) {',
    replace: '    if (false) {',
    expect: 'an unresolved package blocks shipping rather than being skipped',
  },
  {
    id: 'M66',
    defect: 'a second command starts writing status shipped',
    file: LIFECYCLE,
    find: "      to: 'approved',",
    replace: "      to: 'shipped' as never,",
    expect: 'the lifecycle command never writes `shipped`',
  },  {
    id: 'M67',
    defect: 'a non-billable replacement writes a $0.00 line instead of none',
    file: BILL_PLAN,
    find: '  if (!facts.billable) return [];',
    replace: '  if (false) return [];',
    expect: 'billable=false produces NO line, not a zero line',
  },
  {
    id: 'M68',
    defect: 'a missing frozen money tuple is treated as zero rather than refused',
    file: BILL_PLAN,
    find: '  if (!customerPostage || !Number.isFinite(customerPostage.amount)) {',
    replace: '  if (false) {',
    expect: 'a missing frozen money tuple FAILS CLOSED',
  },
  {
    id: 'M69',
    defect: 'the writer stops counting the RETURNED rows, so a partial insert reads as complete',
    file: BILL_WRITE,
    find: '  if (inserted.length !== planned.length) {',
    replace: '  if (false) {',
    expect: 'the writer inserts with RETURNING and counts the RETURNED rows',
  },
  {
    id: 'M70',
    defect: 'onConflictDoNothing is added to a money path',
    file: BILL_WRITE,
    find: '  ).returning({ id: billingLineItems.id, lineType: billingLineItems.lineType });',
    replace: '  ).onConflictDoNothing().returning({ id: billingLineItems.id, lineType: billingLineItems.lineType });',
    expect: 'there is NO onConflictDoNothing on a money path',
  },
  {
    id: 'M71',
    defect: 'the cross-table invariant stops being asserted before the insert',
    file: BILL_WRITE,
    find: '    assertReplacementLineInvariants(line, {',
    replace: '    void ({',
    expect: 'cross-table invariants are asserted in the service',
  },  {
    id: 'M72',
    defect: 'the sweep stops preserving replacement lines, so a routine rebuild erases them',
    file: SWEEP,
    find: '  ...REPLACEMENT_LINE_TYPES,',
    replace: '',
    expect: 'the outbound sweep PRESERVES replacement line types',
  },
  {
    id: 'M73',
    defect: 'regeneration stops excluding invoiced rows and deletes finalized money',
    file: BILL_WRITE,
    find: '      eq(billingLineItems.invoiced, false),',
    replace: '',
    expect: 'the regeneration delete carries ALL FOUR scoping terms',
  },  {
    id: 'M74',
    defect: 'the credit stops carrying replacement_id, so one of two cannot be attributed',
    file: POLICY,
    find: /(adjustmentKind: 'credit',\s*\n)        replacementId: input\.replacementId,/,
    replace: '$1        replacementId: null,',
    expect: 'the credit CARRIES replacement_id through the projection',
  },
  {
    id: 'M75',
    defect: 'the reconciler credits the whole frozen total, refunding twice on a retry',
    file: POLICY,
    find: 'const outstandingCents = frozenCents + priorCents;',
    replace: 'const outstandingCents = frozenCents;',
    expect: 'it credits the DELTA, not the frozen total',
  },
  {
    id: 'M76',
    defect: 'cancellation stops excluding invoiced lines and deletes finalized money',
    file: BILL_WRITE,
    find: /(cancelReplacementBillingInTransaction[\s\S]*?)      eq\(billingLineItems\.invoiced, false\),\r?\n/,
    replace: '$1',
    expect: 'cancellation removes ONLY editable replacement-scoped lines',
  },  {
    id: 'M77',
    defect: 'frozen discovery goes back to a column constraint 0074 forbids, so it matches nothing',
    file: POLICY,
    find: '      where line.client_id = ${input.clientId}',
    replace: '      where line.client_id = ${input.clientId} and line.source_finalization_id is not null',
    expect: 'discovery never asks for source_finalization_id',
  },
  {
    id: 'M78',
    defect: 'the fold stops scoping to frozen money and folds open-period charges too',
    file: FOLD,
    find: '      eq(billingLineItems.invoiced, true),',
    replace: '',
    expect: 'the finalized fold counts ONLY frozen replacement money',
  },
  {
    id: 'M79',
    defect: 'the generator stops folding, so regeneration credits the replacement away again',
    file: GENERATOR,
    find: '  await foldFinalizedReplacementTotalsIntoCandidates(',
    replace: '  await Promise.resolve(); void foldFinalizedReplacementTotalsIntoCandidates; if (false) await foldFinalizedReplacementTotalsIntoCandidatesUnused(',
    expect: 'the generator folds replacement money BEFORE reconciling',
  },
  {
    id: 'M80',
    defect: 'the SQL twin drops the replacement types while the TypeScript set keeps them',
    file: NO_CHARGE,
    find: /\n      'replace_postage', 'replace_pick_pack'/,
    replace: '',
    expect: 'a cancelled original does not zero replacement money — both twins',
  },  {
    id: 'M81',
    defect: 'AC-16 reuses the drift review reason, so the queue cannot tell the two apart',
    file: HOLD,
    find: "      reviewReason: 'original_order_cancelled_label_live',",
    replace: "      reviewReason: 'original_order_line_drift',",
    expect: 'AC-16 keeps its OWN review reasons, never the drift code',
  },
  {
    id: 'M82',
    defect: 'the sweep drops the order lock and can interleave with an in-flight ship',
    file: HOLD,
    find: '  await tx.execute(sql`select pg_advisory_xact_lock(36423, ${input.orderId})`);',
    replace: '',
    expect: 'the sweep takes the SAME order lock every replacement command takes',
  },
  {
    id: 'M83',
    defect: 'the open-hold check narrows to the idempotency key, aborting the second signal',
    file: HOLD,
    find: /sql`\(\$\{replacementOriginalOrderHolds\.resolvedAt\} is null\n[^`]*`,\n/,
    replace: '',
    expect: 'an open hold blocks re-classification, as the partial index requires',
  },
  {
    id: 'M84',
    defect: 'the local cancel branch stops fanning out to its replacements',
    file: ORDER_LIFECYCLE,
    find: '    await raiseReplacementOriginalOrderHoldsInTransaction(tx, {',
    replace: '    if (false) await raiseReplacementOriginalOrderHoldsInTransaction(tx, {',
    expect: 'the local cancel branch fans out IN THE SAME TRANSACTION',
  },
  {
    id: 'M85',
    defect: 'the upstream producer stops looking for shipped originals, so AC-16 never fires',
    file: UPSTREAM,
    find: "      WHERE o.order_status = 'shipped'",
    replace: "      WHERE o.order_status = 'awaiting_shipment'",
    expect: 'the upstream producer raises holds WITHOUT moving the order',
  },
  // ── PS-502 item 11 — the three hand-rolled review writers routed through one ──────────────
  //
  // Deduplicating a write creates a NEW way to regress: someone re-inlines a copy. That is not
  // hypothetical here — it is exactly what the label-purchase path had already done, matching on
  // id alone with no predicate and no row-count check. Each of these puts a hand-rolled copy
  // back at one call site and requires that site's delegation check to be the first to go red.
  {
    id: 'M86',
    defect: 'the shipment command hand-rolls its drift review again, on id alone',
    file: SHIPMENT,
    find: '      await enterReplacementReview(tx, replacement, {',
    replace: "      await tx.update(replacements).set({ status: 'review' })\n        .where(eq(replacements.id, replacement.id));\n      await inlinedReview({",
    expect: 'the drift review delegates to the ONE guarded review writer',
  },
  {
    id: 'M87',
    defect: 'the label-purchase command hand-rolls its post-dispatch review again, on id alone',
    file: LABEL_BUY,
    find: '      await enterReplacementReview(tx, replacement!, {',
    replace: "      await tx.update(replacements).set({ status: 'review' })\n        .where(eq(replacements.id, replacement!.id));\n      await inlinedReview({",
    expect: 'the post-dispatch review delegates to the ONE guarded review writer',
  },
  {
    id: 'M88',
    // Global regex: the hold classifies three phases and calls the writer at all three, so
    // replacing one leaves two and the check would stay green on a defect that is present.
    defect: 'AC-16 stops using the shared review writer, so the copies can drift apart again',
    file: HOLD,
    find: /enterReplacementReview\(tx, before, \{/g,
    replace: "tx.update(replacements).set({ status: 'review' })\n      .where(eq(replacements.id, before.id)); await inlinedReview({",
    expect: 'there is ONE shared review writer, and AC-16 uses it',
  },  {
    id: 'M89',
    defect: 'the fence returns the carrier cost, billing raw postage as customer money',
    file: FENCE,
    find: '    amount: frozen.cShippingRateAmount,',
    replace: '    amount: frozen.selectedRateCost,',
    expect: 'the fence returns the CUSTOMER amount, never the carrier cost',
  },
  {
    id: 'M90',
    defect: 'the equality tripwire goes, so cost leaking through as customer money is billed',
    file: FENCE,
    find: '  if (frozen.cShippingRateAmount === frozen.selectedRateCost) return null;',
    replace: '',
    expect: 'a customer amount equal to the cost is refused',
  },
  {
    id: 'M91',
    defect: 'the invoice owner loses a replacement bucket, so that money belongs to nothing',
    file: INVOICE_TOTALS,
    find: /^.*line_type = 'replace_pick_pack'.*$\r?\n/m,
    replace: '',
    expect: 'both replacement line types have a bucket in EVERY summary owner',
  },  {
    id: 'M92',
    defect: 'the router is mounted but drops out of the auth allowlist, shipping unauthenticated',
    file: MAIN,
    find: /\n  \/\/ PS-502: mounting a router does NOT[\s\S]*?\n  '\/replacements',/,
    replace: '',
    expect: 'the router is in protectedPrefixes, not merely mounted',
  },
  {
    id: 'M93',
    defect: 'the disabled surface stops naming itself, so it reads as a plain permission denial',
    file: ROUTE,
    find: "      { error: 'The replacements surface is not enabled', code: 'REPLACEMENTS_DISABLED' },",
    replace: "      { error: 'The replacements surface is not enabled' },",
    expect: 'the WHOLE router is gated, with a code distinct from not-found',
  },
  {
    id: 'M94',
    defect: 'a route drops to requirePermission, admitting a client portal session',
    file: ROUTE,
    find: "app.get('/', requireInternalPermission('replacements:read')",
    replace: "app.get('/', requirePermission('replacements:read')",
    expect: 'every route denies portal roles outright',
  },
  {
    id: 'M95',
    defect: 'the mapper swallows an unrecognised failure as a coded refusal',
    file: ROUTE,
    find: "  if (typeof e?.httpStatus !== 'number' || typeof e?.code !== 'string') throw error;",
    replace: "  if (false) throw error;",
    expect: 'the route never decides the status code',
  },  {
    id: 'M96',
    defect: 'zero-count classes are reported, burying the real ones in a list of noise',
    file: DIAGNOSTICS,
    find: '    if (count === 0) continue;',
    replace: '',
    expect: 'classes with nothing wrong are OMITTED, and healthy is explicit',
  },
  {
    id: 'M97',
    defect: 'the unbilled sweep stops checking billable, so correct behaviour is reported as an anomaly',
    file: DIAGNOSTICS,
    find: '      where r.billable = true',
    replace: '      where true',
    expect: 'the unbilled-shipment query is scoped to BILLABLE replacements',
  },
  {
    id: 'M98',
    defect: 'an anomaly loses the guidance that makes it actionable',
    file: DIAGNOSTICS,
    find: /\n    action:\n      'Do NOT hand-write a billing line[\s\S]*?fix that path\.',/,
    replace: "\n    action: '',",
    expect: 'every anomaly carries what it means and what to do',
  },  {
    id: 'M99',
    defect: 'the cancel fan-out loses its schema probe, so cancelling an order needs a table production lacks',
    file: ORDER_LIFECYCLE,
    find: '    if (await replacementSchemaPresent(tx)) {',
    replace: '    if (true) {',
    expect: 'every PRE-EXISTING path that names a replacement relation is probe-guarded',
  },
  {
    id: 'M100',
    defect: 'a migration drops out of the ARCHIVE while its digest stays in the verification prose',
    file: MIGRATION_WORKFLOW,
    find: /\n            drizzle\/0101_ps502_replacement_original_order_holds\.sql/,
    replace: '',
    expect: 'the workflow SHIPS and pins 0101_ps502_replacement_original_order_holds.sql',
  },
  {
    id: 'M101',
    defect: 'a digest argument is dropped, so the runner never verifies that migration',
    file: MIGRATION_WORKFLOW,
    find: ' --digest101=${d101}',
    replace: '',
    expect: 'the workflow SHIPS and pins 0101_ps502_replacement_original_order_holds.sql',
  },
  {
    id: 'M102',
    defect: 'the probe serves an explicit connection from the memo, letting a test answer for production',
    file: SCHEMA_PROBE,
    find: '  if (conn) return probe(conn);',
    replace: '',
    expect: 'an explicit connection is never served from the memo',
  },
];

process.exit(runMutationMatrix({
  title: 'PS-502 mutation matrix',
  guard: 'scripts/ps-502-replacement-contract-guard.ts',
  mutations: MUTATIONS,
}));
