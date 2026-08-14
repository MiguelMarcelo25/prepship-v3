/**
 * PS-488 AC-1 guard — Billing row visible reference and type.
 *
 * Offline/pure: no DB, no network, no provider calls, no billing regeneration.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billingRowIdentity } from '../src/services/billing-row-reference';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

function stripGuardComments(source: string): string {
  // Negative assertions must never see the prose describing the rule — four checks in
  // this session fired on a comment instead of code.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

check('an outbound order renders #1234 / Outbound', () => {
  assert.deepEqual(billingRowIdentity({ orderNumber: '1234', orderId: 99 }), {
    rowType: 'Outbound',
    displayReference: '#1234',
  });
});

check('a return renders its STORED reference as a separate #1234-RETURN / Return row', () => {
  assert.deepEqual(
    billingRowIdentity({ orderNumber: '1234', orderId: 99, returnId: 7, returnReference: '1234-RETURN' }),
    { rowType: 'Return', displayReference: '#1234-RETURN' },
  );
});

check('additional returns keep the portal-assigned -2 / -3 numbering', () => {
  for (const ref of ['1234-RETURN-2', '1234-RETURN-3']) {
    assert.equal(
      billingRowIdentity({ orderNumber: '1234', returnId: 8, returnReference: ref }).displayReference,
      `#${ref}`,
    );
  }
});

check('PrepShip never MINTS a -RETURN suffix', () => {
  // The portal generates the suffix from a count of the order's existing returns. A
  // second generator here cannot see that count, so it would render #1234-RETURN for a
  // return already stored as #1234-RETURN-2 — one return, two visible identities.
  const r = billingRowIdentity({ orderNumber: '1234', orderId: 99, returnId: 7, returnReference: null });
  assert.equal(r.rowType, 'Return');
  assert.equal(r.displayReference, null, 'a missing stored reference must not be invented');

  const src = readFileSync('src/services/billing-row-reference.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/`\$\{[^}]*\}-RETURN/.test(src) && !/'-RETURN'|"-RETURN"/.test(src),
    'this module must not construct a -RETURN string');
});

check('row type comes from the relational returnId, not from the reference text', () => {
  // An outbound order number legitimately containing "RETURN" must stay Outbound.
  const r = billingRowIdentity({ orderNumber: 'RETURN-1234', orderId: 99 });
  assert.equal(r.rowType, 'Outbound');
  assert.equal(r.displayReference, '#RETURN-1234');
});

check('a stored reference that already carries # is not doubled', () => {
  assert.equal(
    billingRowIdentity({ returnId: 3, returnReference: '#1234-RETURN' }).displayReference,
    '#1234-RETURN',
  );
  assert.equal(billingRowIdentity({ orderNumber: '#1234' }).displayReference, '#1234');
});

check('a row is never anonymous, but never shows #null or #0 either', () => {
  assert.equal(billingRowIdentity({ orderNumber: null, orderId: 4242 }).displayReference, '#4242');
  assert.equal(billingRowIdentity({ orderNumber: '   ', orderId: 4242 }).displayReference, '#4242');
  for (const bad of [null, undefined, 0, -1, Number.NaN]) {
    assert.equal(
      billingRowIdentity({ orderNumber: null, orderId: bad as number }).displayReference,
      null,
      String(bad),
    );
  }
});

check('the display reference is NOT used as an idempotency key anywhere', () => {
  // AC-1: relational ids stay canonical. PS-487 keys return billing on return:<id>:<kind>
  // so a display string can change without moving money. If billing lines ever keyed on
  // this, renaming an order would mint a duplicate charge.
  const planner = readFileSync('src/services/billing-return-line-planner.ts', 'utf8');
  assert.ok(!/billingRowIdentity|displayReference/.test(planner),
    'the line planner must not key on a display reference');
});

// ── AC-6 slice 1: the fields actually reach the DTO ──────────────────────────

const base = {
  lineType: 'pick_pack', orderId: 4242, orderNumber: '1234',
  clientId: 1, qty: 1, totalCost: '2.50',
};

check('an outbound row carries rowType/displayReference/destination on the DTO', () => {
  // A rule nothing reads is not a feature. AC-1 and AC-2 are only real once they are on
  // the row the Billing columns and CP-059 consume.
  const [row] = toBillingDetailOrderRows([{ ...base, destinationCountry: 'US' }]);
  assert.equal(row.rowType, 'Outbound');
  assert.equal(row.displayReference, '#1234');
  assert.equal(row.destination, 'Domestic');
});

check('a return row carries its own reference and Return type', () => {
  const [row] = toBillingDetailOrderRows([
    { ...base, returnId: 7, returnReference: '1234-RETURN', destinationCountry: 'CA' },
  ]);
  assert.equal(row.rowType, 'Return');
  assert.equal(row.displayReference, '#1234-RETURN');
  assert.equal(row.destination, 'International');
});

check('an unknown-country row reaches the DTO as Needs Review, not Domestic', () => {
  const [row] = toBillingDetailOrderRows([{ ...base, destinationCountry: null }]);
  assert.equal(row.destination, 'Needs Review');
  // The badge must still stay off — unknown is not evidence of a foreign destination.
  assert.equal(row.destinationIsInternational, false);
});


// ── AC-4/AC-6: the card's exact .73 repro, as a REGRESSION fixture ────────
check('outbound and return stay SEPARATE rows and no fee hides behind #1234', () => {
  // The card's Issue section: a repro collapsed an outbound row plus both return lines
  // into only the outbound row, dropping the return reference and 10.73 of charges.
  //
  // The separation machinery was never missing — rowKey already keys returns as
  // "return:<returnId>". The collapse was ENTIRELY isBillingReturnLineType not recognising the
  // portal's canonical names, so return lines fell through to the outbound order key.
  // Fixed in c7d90da6; pinned here because the failure is silent — money merges into the
  // wrong row rather than erroring.
  const rows = toBillingDetailOrderRows([
    { lineType: 'pick_pack', orderId: 4242, orderNumber: '1234', clientId: 1, qty: 1, totalCost: '2.50', destinationCountry: 'US' },
    { lineType: 'return_postage', orderId: 4242, orderNumber: '1234', clientId: 1, qty: 1, totalCost: '7.73', returnId: 7, returnReference: '1234-RETURN' },
    { lineType: 'return_processing_fee', orderId: 4242, orderNumber: '1234', clientId: 1, qty: 1, totalCost: '3.00', returnId: 7, returnReference: '1234-RETURN' },
  ]);
  assert.equal(rows.length, 2, 'outbound and return must be two rows, not one');

  const outbound = rows.find((r) => r.rowType === 'Outbound')!;
  const ret = rows.find((r) => r.rowType === 'Return')!;
  assert.equal(outbound.displayReference, '#1234');
  assert.equal(outbound.grandTotal, 2.5, 'no return fee may merge into the outbound row');
  assert.equal(ret.displayReference, '#1234-RETURN');
  assert.equal(ret.grandTotal, 10.73, '7.73 postage + 3.00 processing');
  // PS-505 INVERTED. These previously asserted `ret.shippingTotal === 7.73` and
  // `ret.pickpackTotal === 3` — the dual-bucket behaviour that put one return charge in
  // two semantic buckets and let fulfillmentFeeTotal report it as a Fulfillment Fee. The
  // note below already observed the two "happen to agree"; they agreed because the same
  // money was written twice. A return line must reach its own bucket and nothing else.
  assert.equal(ret.shippingTotal, 0, 'return postage must not also feed outbound Shipping');
  assert.equal(ret.pickpackTotal, 0, 'return processing must not also feed Pick & Pack');
  assert.equal(ret.fulfillmentFeeTotal, 0, 'return money is never a Fulfillment Fee');
  assert.equal(ret.returnTotal, 10.73, 'the return keeps its own total');
  // AC-6: the dedicated column buckets, which is what the Billing table renders.
  assert.equal(ret.returnPostageTotal, 7.73);
  assert.equal(ret.returnProcessingTotal, 3);
  assert.equal(outbound.returnPostageTotal, 0, 'an outbound row carries no return money');
  assert.equal(outbound.returnProcessingTotal, 0);
});


// ── AC-1: the identity fields reach the DTO from the QUERY, not from a fixture ──
check('billingDetails selects the relational return identity it classifies on', () => {
  // Every behavioural check in this file hand-builds its input rows, so all of them
  // would still pass if the production query never selected returnId/returnReference —
  // the classifier would receive undefined for both, and EVERY return would render as
  // an Outbound row carrying the outbound order's number. The fixtures cannot see that;
  // this is the only offline assertion that can.
  //
  // Scoped to the billingDetails BODY. A file-wide match is satisfied by the return-plan
  // builder ~800 lines earlier, which selects `returnReference: returns.returnReference`
  // for its own purposes — deleting the select from the detail query still passed.
  const service = stripGuardComments(readFileSync('src/services/billing.ts', 'utf8'));
  const start = service.indexOf('export async function billingDetails(');
  assert.ok(start >= 0, 'billingDetails not found — re-anchor this guard');
  const after = service.slice(start + 1);
  const end = after.search(/^export (?:async )?function /m);
  const details = end >= 0 ? after.slice(0, end) : after;

  assert.ok(/returnId:\s*billingLineItems\.returnId/.test(details),
    'the detail query must select billing_line_items.return_id');
  assert.ok(/returnReference:\s*returns\.returnReference/.test(details),
    'the detail query must select the STORED reference from returns');
  // returnReference lives on `returns`, so selecting it requires the join. Asserted on
  // the primary key: joining on anything non-unique would fan the row set out and
  // silently multiply every order's money.
  assert.ok(/leftJoin\(\s*returns\s*,\s*eq\(\s*billingLineItems\.returnId\s*,\s*returns\.id\s*\)\s*\)/.test(details),
    'returns must be joined on its primary key, or the join fans out billing money');
});


// ── AC-6: the UI reads the canonical NAMES the DTO actually emits ────────────
check('the field names the UI reads exist on a real DTO row', () => {
  // BillingDetailDto on the web side is `BillingAnyRecord` — an index signature. tsc
  // therefore accepts row.displayRefrence and renders undefined forever. The expected
  // names are read off LIVE SOT output rather than hardcoded, so this check tracks a
  // rename of the field instead of pinning a string that could drift out of the DTO.
  const [returnRow] = toBillingDetailOrderRows([
    { ...base, returnId: 7, returnReference: '1234-RETURN' },
  ]);
  for (const field of ['displayReference', 'rowType', 'grandTotal', 'returnId'] as const) {
    assert.ok(field in returnRow, `${field} is not on the DTO — the UI reads a name that does not exist`);
  }
  // Each assertion below is anchored to ITS OWN call site. A file-wide /row\.displayReference/
  // is satisfied by any one of the three sites, so deleting the reference from the rendered
  // cell still passed while the sort comparator kept the name alive. Mutation-checked: each
  // of these six sites, broken individually, now fails this guard.
  const table = stripGuardComments(readFileSync('web/src/components/Views/BillingDetailTable.tsx', 'utf8'));
  const invoice = stripGuardComments(readFileSync('web/src/pages/Invoice.tsx', 'utf8'));

  assert.ok(/\{row\.displayReference \|\| row\.orderNumber\}/.test(table),
    'the rendered Order # cell must show the backend reference');
  assert.ok(/case 'orderNumber': return row\.displayReference \|\|/.test(table),
    'the Order # sort must order on the backend reference, or a Return sorts under the outbound number');
  assert.ok(/`return:\$\{row\.returnId\}`/.test(table),
    'the table row key must be the relational return id');

  assert.ok(/\{l\.displayReference \?\? l\.orderNumber \?\? l\.orderId \?\? '—'\}/.test(invoice),
    'the invoice Order # cell must show the backend reference');
  assert.ok(/case 'order':\s*return line\.displayReference \?\?/.test(invoice),
    'the invoice Order # sort must order on the backend reference');
  assert.ok(/`return:\$\{line\.returnId\}`/.test(invoice),
    'the invoice row key must be the relational return id');
});

check('the invoice page reads aggregate money, not the stamped component field', () => {
  // toBillingDetailOrderRows stamps totalCost to a literal 0 on the aggregate and puts
  // the real money in grandTotal, so a row rendered from totalCost is $0.00 for every
  // line of every invoice. Pinned because the page still LOOKS correct: the summary
  // block above the table is fed by a different query and shows the true totals.
  const [row] = toBillingDetailOrderRows([{ ...base, totalCost: '2.50' }]);
  assert.equal(row.totalCost, 0, 'the aggregate must keep stamping the component field to 0');
  assert.equal(row.grandTotal, 2.5, 'the aggregate money must be on grandTotal');

  const invoice = stripGuardComments(readFileSync('web/src/pages/Invoice.tsx', 'utf8'));
  assert.ok(/fmtMoney\(invoiceRowTotal\(l\)\)/.test(invoice),
    'the Amount cell must read the aggregate total');
  assert.ok(!/fmtMoney\(l\.totalCost\)/.test(invoice),
    'the Amount cell must not read the stamped component field');
  // lineType is stamped to the constant 'billing_order' by the same aggregation, so a
  // Type column reading it says "billing order" on every row.
  assert.equal(row.lineType, 'billing_order');
  assert.ok(!/\{l\.lineType\.replace/.test(invoice),
    'the Type column must not render the stamped lineType as its primary value');
});


// ── M3 (Hermes afd440a2): a Return aggregate describes ITSELF ────────────────
const RETURN_BOTH = [
  { ...base, id: 10, lineType: 'return_postage', totalCost: '7.73', unitCost: '7.73', description: 'Return postage', returnId: 7, returnReference: '1234-RETURN' },
  { ...base, id: 11, lineType: 'return_processing_fee', totalCost: '3.00', unitCost: '3.00', description: 'Return processing', returnId: 7, returnReference: '1234-RETURN' },
];

check('a combined Return row has ONE stable status, whatever the arrival order', () => {
  // resolveBillingRowStatus answers for a LINE: postage resolves to 'return_postage',
  // processing to 'return_processing_fee'. The collapse kept whichever initialised the
  // row, so the status of a two-line return depended on the order the rows arrived in.
  const forward = toBillingDetailOrderRows(RETURN_BOTH)[0]!;
  const reverse = toBillingDetailOrderRows([...RETURN_BOTH].reverse())[0]!;
  assert.equal(forward.billingLifecycleStatus, 'return');
  assert.equal(forward.billingStatusLabel, 'Return');
  assert.equal(forward.billingStatusTone, 'purple');
  assert.equal(reverse.billingStatusLabel, forward.billingStatusLabel,
    'reversing arrival order must not change the status');
  // A one-component return gets the SAME status as a two-component one. The aggregate is
  // a return either way; which fees it carries lives in the buckets, not in the status.
  const postageOnly = toBillingDetailOrderRows([RETURN_BOTH[0]!])[0]!;
  assert.equal(postageOnly.billingStatusLabel, 'Return');
});

check('a Return row never presents a COMPONENT as the aggregate', () => {
  // description/qty/unitCost belong to one line. Pinning them to the highest component id
  // made the choice deterministic, but deterministic is not truthful: "Return postage" is
  // the wrong description for a row that is postage AND processing, and a unit cost of
  // 7.73 against a total of 10.73 invites the reader to think the quantity is wrong.
  const row = toBillingDetailOrderRows(RETURN_BOTH)[0]!;
  assert.equal(row.description, null, 'no component description may stand in for the row');
  assert.equal(row.qty, null);
  assert.equal(row.unitCost, null);
  assert.equal(row.grandTotal, 10.73, 'clearing display fields must not touch the money');
});

check('an OUTBOUND aggregate keeps its display fields (ps-394 depends on qty)', () => {
  const row = toBillingDetailOrderRows([
    { ...base, id: 20, lineType: 'pick_pack', totalCost: '2.50', unitCost: '2.50', qty: 3, description: 'Pick & pack' },
    { ...base, id: 21, lineType: 'shipping', totalCost: '4.25', unitCost: '4.25', qty: 1, description: 'Shipping' },
  ])[0]!;
  assert.ok(row.description != null, 'the Return-only clearing must not reach outbound rows');
  assert.ok(row.qty != null);
  assert.ok(typeof row.displayQty === 'string' && row.displayQty.length > 0, 'displayQty still has a quantity to format');
});

check('an ABSENT return fee is distinguishable from a fee that is genuinely zero', () => {
  // The whole point: both carry the number 0. Only presence separates them, and without
  // it a processing-only return exported postage as $0.00 — indistinguishable from a
  // waived postage charge, on a document a client is billed from.
  const processingOnly = toBillingDetailOrderRows([RETURN_BOTH[1]!])[0]!;
  assert.equal(processingOnly.returnPostageTotal, 0);
  assert.equal(processingOnly.hasReturnPostageLine, false, 'never charged postage');
  assert.equal(processingOnly.hasReturnProcessingLine, true);

  const waivedPostage = toBillingDetailOrderRows([
    { ...base, id: 12, lineType: 'return_postage', totalCost: '0.00', returnId: 9, returnReference: '1234-RETURN-2' },
  ])[0]!;
  assert.equal(waivedPostage.returnPostageTotal, 0, 'same number as the absent case');
  assert.equal(waivedPostage.hasReturnPostageLine, true, 'but the charge EXISTS');

  // Presence unions across components and never depends on arrival order.
  const both = toBillingDetailOrderRows(RETURN_BOTH)[0]!;
  assert.equal(both.hasReturnPostageLine, true);
  assert.equal(both.hasReturnProcessingLine, true);
  assert.deepEqual(
    toBillingDetailOrderRows([...RETURN_BOTH].reverse())[0]!.lineTypes,
    both.lineTypes,
    'the line-type set is a property of the row, not of arrival order',
  );
});


check('the UI recognises EVERY return lifecycle the backend can emit', () => {
  // Two call sites in the table each spelled out their own list and both omitted the
  // CANONICAL names the generator writes — 'return_postage' and 'return_processing_fee'.
  // A row carrying either lost its Return styling and its Return backup label, while a
  // row carrying the legacy spelling kept them: the same return, styled differently
  // depending on which vocabulary wrote it.
  //
  // The expected set is DERIVED from the backend's BillingLifecycleStatus union rather
  // than hardcoded here, so adding a return status to the owner makes this fail until the
  // UI is taught about it. A hardcoded copy would be a fourth list to forget to update.
  const statusSource = readFileSync('src/services/billing-row-status.ts', 'utf8');
  const union = /export type BillingLifecycleStatus =([\s\S]*?);/.exec(statusSource)?.[1] ?? '';
  const backendReturnStatuses = [...union.matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1]!)
    .filter((value) => value.startsWith('return'));
  assert.ok(backendReturnStatuses.length >= 5,
    `expected the union to declare the return statuses, found ${backendReturnStatuses.join(', ')}`);

  const table = stripGuardComments(readFileSync('web/src/components/Views/BillingDetailTable.tsx', 'utf8'));
  const declared = /RETURN_LIFECYCLE_STATUSES = new Set\(\[([\s\S]*?)\]\)/.exec(table)?.[1] ?? '';
  for (const status of backendReturnStatuses) {
    assert.ok(new RegExp(`'${status}'`).test(declared),
      `the table must style '${status}' as a Return — the backend can emit it`);
  }
  // And both call sites must go through the shared set rather than re-listing it.
  assert.equal(
    (table.match(/lifecycle === 'return_label'/g) ?? []).length, 0,
    'return lifecycle checks must delegate to the shared set, not re-spell the list',
  );
});


// ── AC-6: the four Billing columns render, and derive nothing ────────────────
check('the four AC-6 columns exist in the registry and are visible by default', () => {
  const parity = readFileSync('web/src/components/Views/billing-parity.ts', 'utf8');
  for (const [id, label] of [
    ['rowType', 'Type'],
    ['destination', 'Destination'],
    ['returnPostage', 'Return Postage'],
    ['returnProcessing', 'Return Processing'],
  ]) {
    assert.ok(parity.includes(`id: '${id}', label: '${label}'`), `${label} column missing`);
    assert.ok(new RegExp(`^  '${id}',`, 'm').test(parity),
      `${label} must be in the default visible set — a column nobody sees is not a column`);
  }
});

check('the Billing table renders backend values and computes none of them', () => {
  const table = stripGuardComments(
    readFileSync('web/src/components/Views/BillingDetailTable.tsx', 'utf8'),
  );
  assert.ok(/row\.returnPostageTotal/.test(table) && /row\.returnProcessingTotal/.test(table),
    'return money must come from the backend fields');
  assert.ok(/row\.destination/.test(table) && /row\.rowType/.test(table));

  // No FE derivation of any of the four. Each of these would make the frontend a second
  // source of truth for a money-surface fact PS-488 assigns to the backend.
  assert.ok(!/destinationCountry\s*(?:===|!==|==|!=)\s*['"]/.test(table),
    'the FE must not compare country codes');
  assert.ok(!/['"]-RETURN['"]/.test(table),
    'the FE must not build a return reference');
  assert.ok(!/returnPostageTotal[^\n]*\?\?[^\n]*shippingTotal/.test(table),
    'return postage must not fall back to shippingTotal — that is FE billing math');
  assert.ok(!/Needs Review/.test(table.replace(/data-billing-destination[^\n]*/g, '')),
    'the Needs Review string is a backend value, not an FE literal');
});


// ── AC-6 STOPGAP: return money on the invoice export ────────────────────────
check('the invoice xlsx carries Return Postage and Return Processing', () => {
  const billing = readFileSync('src/routes/billing.ts', 'utf8');
  assert.ok(/header: 'Return Postage'/.test(billing));
  assert.ok(/header: 'Return Processing'/.test(billing));
  // Both vocabularies, or frozen rows carrying the old spelling export as 0.00.
  assert.ok(/'return_postage', 'return_label'/.test(billing),
    'the export aggregate must accept both return-postage spellings');
  assert.ok(/'return_processing_fee', 'return_processing'/.test(billing),
    'the export aggregate must accept both return-processing spellings');
});

check('AC-6 CLOSED: the invoice reconciles from the canonical DTO', () => {
  // This assertion used to be INVERTED — it asserted the defect (`usesCanonicalDto ===
  // false`) so a stopgap could not be quietly forgotten, and said in its own message that
  // it must be rewritten once the export was routed through the canonical owner. M3 did
  // that, so it is rewritten here in the direction it was always meant to end up.
  const billing = stripGuardComments(readFileSync('src/routes/billing.ts', 'utf8'));
  const start = billing.indexOf('async function billingInvoiceData(');
  assert.ok(start >= 0, 'billingInvoiceData not found — re-anchor this guard');
  const after = billing.slice(start + 1);
  const end = after.search(/^(?:export )?(?:async )?function /m);
  const invoiceData = end >= 0 ? after.slice(0, end) : after;

  // PS-488 M3 (Hermes, afd440a2 review): this previously REQUIRED `await billingDetails(`
  // here — it mandated the very defect it was meant to prevent. Reading the canonical DTO
  // through a second query meant two reads of billing_line_items inside one request and
  // outside any shared snapshot, so the invoice could disagree with itself between its
  // outbound rows and its return rows. Canonical OWNERSHIP is about which function
  // decides, not which query fetched the bytes, so the owners are now applied to the
  // single read's rows and the second read is forbidden.
  assert.ok(!/billingDetails\(/.test(invoiceData),
    'the invoice builder must NOT issue a second read of billing_line_items');
  assert.ok(/left join returns r on r\.id = b\.return_id/.test(billing),
    'the ONE read must join returns, or the persisted reference is unavailable without a second read');
  assert.ok(/billingRowIdentity\(/.test(invoiceData),
    'return identity must come from the canonical owner, not be assembled here');
  assert.ok(/resolveBillingReturnRowStatus\(/.test(invoiceData),
    'return status must come from the shared owner, not from a component line');
  assert.ok(/reconcileInvoiceRows\(/.test(invoiceData),
    'the invoice builder must reconcile through the shared projection');
  // The complementary predicates are what make "exactly one producer per return" true.
  // Without the filter the SQL return rows and the appended canonical rows both ship and
  // every return is billed twice on the invoice — the single worst outcome this ticket
  // could produce, and invisible in any assertion that only checks a total is non-zero.
  assert.ok(/outbound:\s*details\.filter\(\(row\) => row\.return_id == null\)/.test(invoiceData),
    'return-bearing SQL rows must be dropped, or returns are double-counted');
  assert.ok(/canonical:\s*canonicalRows/.test(invoiceData));
  // The stopgap label must be gone from the code it applied to, so the next reader is not
  // told the export is still a second read path.
  assert.ok(!/PS-488 AC-6 STOPGAP/.test(billing),
    'the stopgap label must be removed now that the cutover has happened');
});
if (failures > 0) {
  console.error(`\nFAIL PS-488 billing row reference guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-488 billing row reference guard');
