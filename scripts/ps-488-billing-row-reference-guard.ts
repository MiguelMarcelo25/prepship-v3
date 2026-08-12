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
  assert.equal(ret.shippingTotal, 7.73);
  assert.equal(ret.pickpackTotal, 3);
  // AC-6: the dedicated column buckets, which is what the Billing table renders. The
  // generic shipping/pickpack totals above happen to agree here, but the columns must
  // read their own backend fields rather than borrow those.
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

check('the export is STILL a second read path — this is a stopgap, not AC-6', () => {
  // Deliberately asserts the DEFECT, so it cannot be quietly forgotten. AC-6 requires
  // the invoice to reconcile from the canonical DTO; today it runs its own query, so
  // the table and the invoice are two independent derivations of the same money that
  // merely agree. When the export is routed through toBillingDetailOrderRows this
  // check flips and must be rewritten — that is the signal AC-6 is actually done.
  const billing = readFileSync('src/routes/billing.ts', 'utf8');
  const usesCanonicalDto = /toBillingDetailOrderRows/.test(billing);
  assert.equal(usesCanonicalDto, false,
    'export now uses the canonical DTO — remove this stopgap assertion and close AC-6');
  assert.ok(/PS-488 AC-6 STOPGAP/.test(billing),
    'the stopgap must stay labelled in the code it applies to');
});
if (failures > 0) {
  console.error(`\nFAIL PS-488 billing row reference guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-488 billing row reference guard');
