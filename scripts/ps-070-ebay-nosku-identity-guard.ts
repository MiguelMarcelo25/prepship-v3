/**
 * PS-070 Guard — eBay no-SKU Print Queue identity / grouping (pure, no DB).
 *
 * Proves the DoD: blank-SKU eBay lines get a stable, human-pickable identity
 * (title fallback, never "UNKNOWN SKU"); different blank-SKU titles never
 * collapse; identical titles + qty batch; combos are order-independent; and the
 * frontend grouping module agrees token-for-token with the backend PDF module.
 *
 *   npx tsx scripts/ps-070-ebay-nosku-identity-guard.ts
 *
 * Read-only: no DB, no IO, mutates nothing.
 */
import {
  resolveQueueLineIdentity as beResolve,
  collapseIdentityLines as beCollapse,
} from '../src/services/print-queue-identity';
import {
  resolveQueueLineIdentity as feResolve,
  buildQueueAddPayload,
  groupPrintQueueEntries,
  type PrintQueueEntryDto,
} from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
function checkTrue(name: string, cond: boolean) {
  check(name, cond, true);
}

// ── 1) Identity resolution + frontend/backend parity ────────────────────────
const samples = [
  { sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 2 },
  { name: 'Samyang Buldak Variety Pack', quantity: 1 },            // no sku
  { name: 'Chapagetti 5-Pack', quantity: 2 },                      // no sku, diff title
  { lineItemId: 'v1|789', quantity: 1 },                           // id only, no sku/title
  { quantity: 1 },                                                 // nothing usable
];
for (const s of samples) {
  const be = beResolve(s);
  const fe = feResolve(s);
  check(`parity groupToken ${JSON.stringify(s).slice(0, 28)}`, fe.groupToken, be.groupToken);
  check(`parity cardTitle  ${JSON.stringify(s).slice(0, 28)}`, fe.cardTitle, be.cardTitle);
  check(`parity skuLine    ${JSON.stringify(s).slice(0, 28)}`, fe.skuLineText, be.skuLineText);
}

// No-SKU title → title fallback, never UNKNOWN SKU.
const noSku = beResolve({ name: 'Samyang Buldak Variety Pack', quantity: 1 });
check('no-SKU groupToken keyed by title', noSku.groupToken, 'NOSKU:samyang buldak variety pack');
check('no-SKU card shows title', noSku.cardTitle, 'Samyang Buldak Variety Pack');
checkTrue('no-SKU sku line is not "UNKNOWN SKU"', !/unknown sku/i.test(noSku.skuLineText));

// Different blank-SKU titles do NOT share a token.
checkTrue(
  'title A != title B token',
  beResolve({ name: 'Samyang Buldak Variety Pack' }).groupToken !==
    beResolve({ name: 'Chapagetti 5-Pack' }).groupToken,
);

// Truly empty → UNRESOLVED, flagged unsafe.
const unresolved = beResolve({ quantity: 1 });
check('unresolved token', unresolved.groupToken, 'UNRESOLVED');
check('unresolved card label', unresolved.cardTitle, 'UNRESOLVED EBAY ITEM');

// ── 2) collapseIdentityLines keeps no-SKU lines + merges duplicates ─────────
const combo = beCollapse([
  { sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 1 },
  { name: 'Samyang Buldak Variety Pack', quantity: 1 },
]);
check('multi-SKU combo keeps both lines', combo.length, 2);
checkTrue('combo includes the SKU line', combo.some((l) => l.sku === 'Booster-gel-001'));
checkTrue('combo includes the no-SKU title line', combo.some((l) => l.cardTitle === 'Samyang Buldak Variety Pack' && l.sku === ''));

const dupTitle = beCollapse([
  { name: 'Samyang Buldak Variety Pack', quantity: 1 },
  { name: 'samyang  buldak variety pack', quantity: 2 }, // case/space variant -> same identity
]);
check('duplicate no-SKU titles collapse to one line', dupTitle.length, 1);
check('duplicate no-SKU qty merged', dupTitle[0]!.qty, 3);

// ── 3) Full pipeline: buildQueueAddPayload + groupPrintQueueEntries ─────────
function entryFor(order: { orderId: string; orderNumber: string; clientId: number; items: unknown[] }, i: number): PrintQueueEntryDto {
  const p = buildQueueAddPayload(order as never, `https://example.test/label-${i}.pdf`);
  return {
    queue_entry_id: `qe-${i}`,
    order_id: p.order_id,
    order_number: p.order_number,
    client_id: p.client_id,
    label_url: p.label_url,
    sku_group_id: p.sku_group_id,
    primary_sku: p.primary_sku,
    item_description: p.item_description,
    order_qty: p.order_qty,
    multi_sku_data: p.multi_sku_data,
    status: 'queued',
    print_count: 0,
    last_printed_at: null,
    queued_at: '2026-06-03T00:00:00Z',
  };
}
const O = (orderId: string, items: unknown[]) => ({ orderId, orderNumber: `#${orderId}`, clientId: 4, items });

// Two unrelated no-SKU eBay products must NOT group together.
const gAB = groupPrintQueueEntries([
  entryFor(O('A', [{ name: 'Samyang Buldak Variety Pack', quantity: 1 }]), 1),
  entryFor(O('B', [{ name: 'Chapagetti 5-Pack', quantity: 1 }]), 2),
]);
check('unrelated no-SKU titles => 2 groups', gAB.length, 2);
checkTrue('no group label is UNKNOWN SKU', gAB.every((g) => !/unknown sku/i.test(g.label)));
checkTrue('no-SKU group shows the product title', gAB.some((g) => g.label === 'Samyang Buldak Variety Pack'));

// Same no-SKU title + qty across two orders MUST batch into one group.
const gSame = groupPrintQueueEntries([
  entryFor(O('A', [{ name: 'Samyang Buldak Variety Pack', quantity: 1 }]), 1),
  entryFor(O('A2', [{ name: 'Samyang Buldak Variety Pack', quantity: 1 }]), 2),
]);
check('same no-SKU title+qty => 1 group', gSame.length, 1);
check('same no-SKU group has 2 orders', gSame[0]!.orders.length, 2);

// Same combo in different line order => same group.
const gCombo = groupPrintQueueEntries([
  entryFor(O('C1', [{ sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 1 }, { name: 'Samyang Buldak Variety Pack', quantity: 1 }]), 1),
  entryFor(O('C2', [{ name: 'Samyang Buldak Variety Pack', quantity: 1 }, { sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 1 }]), 2),
]);
check('reordered combo => 1 group', gCombo.length, 1);
checkTrue('combo description shows both identities', /Samyang Buldak Variety Pack/.test(gCombo[0]!.description) && /Booster/.test(gCombo[0]!.description));

// A normal SKU order and a no-SKU eBay title must NOT collapse together.
const gMixed = groupPrintQueueEntries([
  entryFor(O('S1', [{ sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 2 }]), 1),
  entryFor(O('N1', [{ name: 'Booster Gel', quantity: 2 }]), 2), // same name, NO sku
]);
check('SKU vs no-SKU same-name => 2 groups (sku identity wins)', gMixed.length, 2);

if (failures > 0) {
  console.error(`\nFAIL PS-070 eBay no-SKU identity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-070 eBay no-SKU identity guard');
