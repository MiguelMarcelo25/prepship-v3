/**
 * PS-499 Step 10 — the socket-backed route suite, cases A-P.
 *
 * Every case drives the REAL HTTP route (see ps-499-route-harness.ts) and asserts
 * against real persisted rows: billing lines, all three sidecar classes, order
 * descriptions and the required append-only audit row. Source regexes live in the
 * separate guard; nothing here substitutes text matching for persistence.
 *
 * The contract under test: a bulk import changes ONLY the authorities the operator
 * actually pasted. Untouched fields are absent from the payload, so they must leave
 * no trace — no manual override, no fee waiver, no pinned box price.
 */
import { startHarness, type Harness } from './ps-499-route-harness.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

function eq(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

const CLIENT = 17;
const CLIENT_NO_PRICING = 18;
const ORDER = 501;
const ORDER_NO_PRICING = 502;
const SHIPMENT = 901;

const PKG_STAMPED = 42; // configured 5.00
const PKG_OTHER = 43; // configured 8.00
const PKG_UNPRICED = 45; // no configured price for CLIENT
const PKG_UNKNOWN = 999;

type Snapshot = {
  lines: string;
  overrides: string;
  waivers: string;
  boxes: string;
  descriptions: string;
  auditCount: number;
};

/** Normalised business values — money as fixed strings, stable ordering, no timestamps. */
async function snapshot(h: Harness): Promise<Snapshot> {
  const lines = await h.query<Record<string, unknown>>(
    `select client_id, order_id, line_type, description, qty::text, unit_cost::text, total_cost::text, package_id
     from billing_line_items order by order_id, line_type, description`,
  );
  const overrides = await h.query<Record<string, unknown>>(
    `select order_id, client_id, line_type, amount::text, note from billing_manual_overrides order by order_id, line_type`,
  );
  const waivers = await h.query<Record<string, unknown>>(
    `select order_id, decision from billing_fee_waivers order by order_id`,
  );
  const boxes = await h.query<Record<string, unknown>>(
    `select order_id, package_id, override_price::text, note from billing_box_resolutions order by order_id`,
  );
  const descriptions = await h.query<Record<string, unknown>>(
    `select order_id, description from billing_order_descriptions order by order_id`,
  );
  const audit = await h.query<{ n: string }>(`select count(*)::text as n from audit_log`);
  return {
    lines: JSON.stringify(lines),
    overrides: JSON.stringify(overrides),
    waivers: JSON.stringify(waivers),
    boxes: JSON.stringify(boxes),
    descriptions: JSON.stringify(descriptions),
    auditCount: Number(audit[0]?.n ?? 0),
  };
}

function assertUnchanged(before: Snapshot, after: Snapshot, what: string): void {
  eq(after.lines, before.lines, `${what}: billing lines must be unchanged`);
  eq(after.overrides, before.overrides, `${what}: manual overrides must be unchanged`);
  eq(after.waivers, before.waivers, `${what}: fee waivers must be unchanged`);
  eq(after.boxes, before.boxes, `${what}: box resolutions must be unchanged`);
  eq(after.descriptions, before.descriptions, `${what}: order descriptions must be unchanged`);
  eq(after.auditCount, before.auditCount, `${what}: no audit row may be appended`);
}

/**
 * Reference data is seeded once. Cascading a truncate through orders/clients trips
 * the append-only inventory_ledger guard, and only the billing tables need to be
 * clean between cases anyway.
 */
async function seedStatic(h: Harness): Promise<void> {
  await h.query(`insert into clients (id, name, active) values
    (${CLIENT}, 'PS499 Client', true), (${CLIENT_NO_PRICING}, 'PS499 No Box Pricing', true)`);
  await h.query(`insert into orders (id, order_number) values (${ORDER}, '2515'), (${ORDER_NO_PRICING}, '2516')`);
  await h.query(`insert into shipments (id) values (${SHIPMENT})`);
  await h.query(`insert into packages (id, name, source) values
    (${PKG_STAMPED}, '9x6x3', 'custom'), (${PKG_OTHER}, '12x10x3', 'custom'), (${PKG_UNPRICED}, '8x8x8', 'custom')`);
  await h.query(`insert into billing_config (client_id, package_cost_markup) values
    (${CLIENT}, '10.00'), (${CLIENT_NO_PRICING}, '10.00')`);
  // CLIENT is on a box-pricing programme; CLIENT_NO_PRICING has no price rows at all.
  await h.query(`insert into client_package_prices (client_id, package_id, price) values
    (${CLIENT}, ${PKG_STAMPED}, '5.00'), (${CLIENT}, ${PKG_OTHER}, '8.00')`);
}

async function reset(h: Harness, opts: { withMissingBoxLine?: boolean; staleOverridePrice?: string } = {}): Promise<void> {
  // No CASCADE: these are all leaf tables for this suite. audit_log's append-only
  // trigger fires on UPDATE/DELETE, not TRUNCATE, so history stays immutable while
  // still being resettable between cases.
  await h.query(`truncate billing_line_items, billing_manual_overrides, billing_fee_waivers,
    billing_box_resolutions, billing_order_descriptions, audit_log restart identity`);

  const line = (lineType: string, description: string, amount: string, orderId = ORDER, clientId = CLIENT) =>
    `(${clientId}, ${orderId}, '2515', ${SHIPMENT}, '2026-07-01', '${lineType}', '${description}', '1.00', '${amount}', '${amount}', ${PKG_STAMPED})`;

  await h.query(`insert into billing_line_items
    (client_id, order_id, order_number, shipment_id, ship_date, line_type, description, qty, unit_cost, total_cost, package_id)
    values
      ${line('pick_pack', 'Pick & Pack', '3.50')},
      ${line('additional_unit', 'Additional Units', '0.75')},
      ${line('package_cost', 'Box (9x6x3)', '5.50')},
      ${line('shipping', 'Shipping', '12.00')},
      ${line('pick_pack', 'Pick & Pack', '3.50', ORDER_NO_PRICING, CLIENT_NO_PRICING)}`);

  if (opts.withMissingBoxLine) {
    await h.query(`insert into billing_line_items
      (client_id, order_id, order_number, shipment_id, ship_date, line_type, description, qty, unit_cost, total_cost)
      values (${CLIENT}, ${ORDER}, '2515', ${SHIPMENT}, '2026-07-01', 'package_cost_missing', 'No box cost', '1.00', '0.00', '0.00')`);
  }
  if (opts.staleOverridePrice) {
    await h.query(`insert into billing_box_resolutions (order_id, package_id, override_price, note)
      values (${ORDER}, ${PKG_STAMPED}, '${opts.staleOverridePrice}', 'stale pin')`);
  }
}

type PatchBody = Record<string, unknown>;

async function patch(h: Harness, body: PatchBody, orderId = ORDER) {
  const res = await h.app.request(`/billing/details/${orderId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

const lineOf = async (h: Harness, lineType: string, orderId = ORDER) => {
  const rows = await h.query<{ total_cost: string; package_id: number | null; description: string }>(
    `select total_cost::text, package_id, description from billing_line_items
     where order_id=${orderId} and line_type='${lineType}' limit 1`,
  );
  return rows[0] ?? null;
};

const auditDetails = async (h: Harness) => {
  const rows = await h.query<{ details: unknown }>(
    `select details from audit_log where action='invoice_line_edit' order by id desc limit 1`,
  );
  const raw = rows[0]?.details;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any> | undefined;
};

async function main(): Promise<void> {
  const h = await startHarness();
  try {
    await seedStatic(h);

    // ─── A — shipping-only, positive amount ──────────────────────────────────
    await reset(h);
    const beforeA = await snapshot(h);
    const resA = await patch(h, {
      source: 'bulk_import',
      clientId: CLIENT,
      shipping: 20.83,
      reason: 'July HUGRAB correction',
    });
    const afterA = await snapshot(h);
    const detailsA = await auditDetails(h);
    const shippingA = await lineOf(h, 'shipping');
    const pickPackA = await lineOf(h, 'pick_pack');
    const additionalA = await lineOf(h, 'additional_unit');
    const packageA = await lineOf(h, 'package_cost');
    const overridesA = await h.query<{ line_type: string; amount: string }>(
      `select line_type, amount::text from billing_manual_overrides order by line_type`,
    );

    check('A — shipping-only import succeeds', () => {
      eq(resA.status, 200, `body ${JSON.stringify(resA.body)}`);
    });
    check('A — the shipping line becomes exactly 20.83', () => {
      eq(shippingA?.total_cost, '20.83', 'shipping line');
    });
    check('A — prep and box lines are untouched', () => {
      eq(pickPackA?.total_cost, '3.50', 'pick & pack must not move');
      eq(additionalA?.total_cost, '0.75', 'additional units must not move');
      eq(packageA?.total_cost, '5.50', 'package cost must not move');
    });
    check('A — exactly one manual override exists, for shipping', () => {
      eq(JSON.stringify(overridesA.map((o) => o.line_type)), JSON.stringify(['shipping']), 'override kinds');
      eq(overridesA[0]?.amount, '20.83', 'override amount');
    });
    check('A — no fee waiver and no box resolution appear', () => {
      eq(afterA.waivers, beforeA.waivers, 'fee waivers must be byte-equivalent');
      eq(afterA.boxes, beforeA.boxes, 'box resolutions must be byte-equivalent');
    });
    check('A — audit lists shipping included and everything else omitted', () => {
      eq(Object.keys(detailsA?.patchIntent?.included ?? {}).sort().join(','), 'shipping', 'included keys');
      const omitted = (detailsA?.patchIntent?.omitted ?? []) as string[];
      for (const field of ['pickPack', 'additional', 'packageCost', 'packageId', 'orderDescription']) {
        if (!omitted.includes(field)) throw new Error(`${field} must be listed as omitted`);
      }
      eq(detailsA?.source, 'bulk_import', 'audit source');
    });
    // ─── B — shipping-only, explicit $0 ──────────────────────────────────────
    await reset(h);
    const resB = await patch(h, { source: 'bulk_import', clientId: CLIENT, shipping: 0, reason: 'Waive intl shipping' });
    const shippingB = await lineOf(h, 'shipping');
    const overridesB = await h.query<{ line_type: string; amount: string }>(
      `select line_type, amount::text from billing_manual_overrides`,
    );
    const waiversB = await h.query(`select * from billing_fee_waivers`);
    const detailsB = await auditDetails(h);

    check('B — an explicitly pasted $0 shipping is applied, not dropped as falsy', () => {
      eq(resB.status, 200, `body ${JSON.stringify(resB.body)}`);
      eq(shippingB?.total_cost, '0.00', 'shipping line must become 0.00');
    });
    check('B — the $0 is a durable shipping override', () => {
      eq(JSON.stringify(overridesB.map((o) => o.line_type)), JSON.stringify(['shipping']), 'override kinds');
      eq(overridesB[0]?.amount, '0.00', 'override amount');
    });
    check('B — a $0 SHIPPING never creates a prep fee waiver', () => {
      // The July defect was a $0 in the PREP fields. A $0 shipping is a different
      // decision and must not touch billing_fee_waivers.
      eq(waiversB.length, 0, 'no fee waiver may exist');
    });
    check('B — audit shows shipping under included as 0.00, not omitted', () => {
      eq(detailsB?.patchIntent?.included?.shipping?.requested, '0.00', 'included shipping value');
      const omitted = (detailsB?.patchIntent?.omitted ?? []) as string[];
      if (omitted.includes('shipping')) throw new Error('an explicit $0 must not be listed as omitted');
    });

    // ─── C — box-only, a different package ───────────────────────────────────
    await reset(h);
    const resC = await patch(h, { source: 'bulk_import', clientId: CLIENT, packageId: PKG_OTHER, reason: 'Correct box' });
    const packageC = await lineOf(h, 'package_cost');
    const shippingC = await lineOf(h, 'shipping');
    const boxesC = await h.query<{ package_id: number; override_price: string | null }>(
      `select package_id, override_price::text from billing_box_resolutions`,
    );
    const overridesC = await h.query(`select * from billing_manual_overrides`);
    const waiversC = await h.query(`select * from billing_fee_waivers`);
    const detailsC = await auditDetails(h);

    check('C — the server prices the box: 8.00 configured + 10% markup = 8.80', () => {
      eq(resC.status, 200, `body ${JSON.stringify(resC.body)}`);
      // The old frontend would have submitted the raw 8.00 and lost the markup.
      eq(packageC?.total_cost, '8.80', 'package cost line');
    });
    check('C — a durable box directive is written with NO pinned price', () => {
      eq(boxesC.length, 1, 'exactly one box resolution');
      eq(Number(boxesC[0]?.package_id), PKG_OTHER, 'resolution package');
      eq(boxesC[0]?.override_price, null, 'override_price must stay null');
    });
    check('C — a box import touches no prep sidecar and no shipping', () => {
      eq(overridesC.length, 0, 'no manual override may be written');
      eq(waiversC.length, 0, 'no fee waiver may be written');
      eq(shippingC?.total_cost, '12.00', 'shipping must not move');
    });
    check('C — the resolved cost is audited as a server effect, not operator input', () => {
      eq(Object.keys(detailsC?.patchIntent?.included ?? {}).sort().join(','), 'packageId', 'included keys');
      eq(detailsC?.resolvedEffects?.packageCost?.authority, 'billing_box_policy', 'authority');
      eq(detailsC?.resolvedEffects?.packageCost?.overridePrice, null, 'resolved effect override');
      const omitted = (detailsC?.patchIntent?.omitted ?? []) as string[];
      if (!omitted.includes('packageCost')) throw new Error('packageCost must be omitted, not attributed to the operator');
    });

    // ─── D — box-only, SAME package as the stamped one (the regression) ──────
    await reset(h, { withMissingBoxLine: true, staleOverridePrice: '99.00' });
    const resD = await patch(h, { source: 'bulk_import', clientId: CLIENT, packageId: PKG_STAMPED, reason: 'Confirm box' });
    const packageD = await lineOf(h, 'package_cost');
    const missingD = await lineOf(h, 'package_cost_missing');
    const boxesD = await h.query<{ package_id: number; override_price: string | null }>(
      `select package_id, override_price::text from billing_box_resolutions`,
    );
    const overridesD = await h.query(`select * from billing_manual_overrides`);

    check('D — a pasted box equal to the stamped box is still explicit intent', () => {
      eq(resD.status, 200, `body ${JSON.stringify(resD.body)}`);
      // 5.00 + 10% — proving the resolved cost replaced the stale 99.00 pin.
      eq(packageD?.total_cost, '5.50', 'package cost must be re-resolved from config');
    });
    check('D — the stale override_price is cleared, not preserved', () => {
      eq(boxesD.length, 1, 'exactly one box resolution');
      eq(boxesD[0]?.override_price, null, 'a bulk import never leaves a pinned price');
      eq(Number(boxesD[0]?.package_id), PKG_STAMPED, 'resolution package');
    });
    check('D — package_cost_missing is deleted once a valid cost line exists', () => {
      eq(missingD, null, 'the review line must not survive beside a resolved cost');
    });
    check('D — no prep sidecar is written by a same-package box import', () => {
      eq(overridesD.length, 0, 'no manual override may be written');
    });

    // ─── E — combined box + shipping ─────────────────────────────────────────
    await reset(h);
    const resE = await patch(h, {
      source: 'bulk_import',
      clientId: CLIENT,
      packageId: PKG_OTHER,
      shipping: 20.83,
      reason: 'Correct box and intl shipping',
    });
    const packageE = await lineOf(h, 'package_cost');
    const shippingE = await lineOf(h, 'shipping');
    const pickPackE = await lineOf(h, 'pick_pack');
    const overridesE = await h.query<{ line_type: string }>(`select line_type from billing_manual_overrides`);
    const waiversE = await h.query(`select * from billing_fee_waivers`);
    const boxesE = await h.query<{ override_price: string | null }>(
      `select override_price::text from billing_box_resolutions`,
    );
    const detailsE = await auditDetails(h);

    check('E — combined changes exactly the box and the shipping', () => {
      eq(resE.status, 200, `body ${JSON.stringify(resE.body)}`);
      eq(packageE?.total_cost, '8.80', 'server-resolved box cost');
      eq(shippingE?.total_cost, '20.83', 'pasted shipping');
      eq(pickPackE?.total_cost, '3.50', 'prep must not move');
    });
    check('E — only the shipping authority is recorded, box price stays unpinned', () => {
      eq(JSON.stringify(overridesE.map((o) => o.line_type)), JSON.stringify(['shipping']), 'override kinds');
      eq(waiversE.length, 0, 'no fee waiver');
      eq(boxesE[0]?.override_price, null, 'override_price null');
    });
    check('E — audit includes exactly packageId and shipping', () => {
      eq(Object.keys(detailsE?.patchIntent?.included ?? {}).sort().join(','), 'packageId,shipping', 'included keys');
      const omitted = (detailsE?.patchIntent?.omitted ?? []) as string[];
      for (const field of ['pickPack', 'additional', 'packageCost']) {
        if (!omitted.includes(field)) throw new Error(`${field} must be omitted`);
      }
    });

    // ─── F — preexisting unrelated sidecars are preserved ────────────────────
    await reset(h);
    await h.query(`insert into billing_manual_overrides (order_id, client_id, line_type, amount, note)
      values (${ORDER}, ${CLIENT}, 'pick_pack', '3.50', 'sentinel prep decision')`);
    await h.query(`insert into billing_fee_waivers (order_id, decision) values (${ORDER}, 'not_waived')`);
    const beforeF = await snapshot(h);
    const resF = await patch(h, { source: 'bulk_import', clientId: CLIENT, packageId: PKG_OTHER, reason: 'Box only' });
    const overridesF = await h.query<{ line_type: string; amount: string; note: string | null }>(
      `select line_type, amount::text, note from billing_manual_overrides order by line_type`,
    );
    const waiversF = await h.query<{ decision: string }>(`select decision from billing_fee_waivers`);

    check('F — a box-only import leaves a preexisting prep override exactly as it was', () => {
      eq(resF.status, 200, `body ${JSON.stringify(resF.body)}`);
      eq(overridesF.length, 1, 'the sentinel override must survive and no new one appear');
      eq(overridesF[0]?.line_type, 'pick_pack', 'sentinel kind');
      eq(overridesF[0]?.amount, '3.50', 'sentinel amount unchanged');
      eq(overridesF[0]?.note, 'sentinel prep decision', 'sentinel note not refreshed');
    });
    check('F — a preexisting fee waiver is neither updated nor cleared', () => {
      eq(waiversF.length, 1, 'waiver row count');
      eq(waiversF[0]?.decision, 'not_waived', 'waiver decision untouched');
    });
    void beforeF;

    // ─── G/H/I/J — boundary rejections, zero mutation ────────────────────────
    for (const [label, body, expectedError] of [
      ['G — pickPack', { source: 'bulk_import', clientId: CLIENT, shipping: 1, pickPack: 0, reason: 'ps499 boundary' }, 'BULK_IMPORT_FORBIDDEN_FIELDS'],
      ['G — additional', { source: 'bulk_import', clientId: CLIENT, shipping: 1, additional: 0, reason: 'ps499 boundary' }, 'BULK_IMPORT_FORBIDDEN_FIELDS'],
      ['G — packageCost', { source: 'bulk_import', clientId: CLIENT, shipping: 1, packageCost: 0, reason: 'ps499 boundary' }, 'BULK_IMPORT_FORBIDDEN_FIELDS'],
      ['G — all three', { source: 'bulk_import', clientId: CLIENT, shipping: 1, pickPack: 0, additional: 0, packageCost: 0, reason: 'ps499 boundary' }, 'BULK_IMPORT_FORBIDDEN_FIELDS'],
      ['H — null packageId', { source: 'bulk_import', clientId: CLIENT, packageId: null, reason: 'ps499 boundary' }, 'BULK_IMPORT_NULL_PACKAGE_ID'],
      ['I — empty patch', { source: 'bulk_import', clientId: CLIENT, reason: 'ps499 boundary' }, 'BULK_IMPORT_EMPTY_PATCH'],
      ['I — description only', { source: 'bulk_import', clientId: CLIENT, reason: 'ps499 boundary', orderDescription: 'just a note' }, 'BULK_IMPORT_EMPTY_PATCH'],
    ] as const) {
      await reset(h);
      const before = await snapshot(h);
      const res = await patch(h, body as PatchBody);
      const after = await snapshot(h);
      check(`${label} is rejected 400 with zero mutation`, () => {
        eq(res.status, 400, `body ${JSON.stringify(res.body)}`);
        eq(res.body.error, expectedError, 'stable error code');
        assertUnchanged(before, after, label);
      });
    }

    // J — the stale pre-PS-499 payload: no source, every money field.
    await reset(h);
    const beforeJ = await snapshot(h);
    const resJ = await patch(h, {
      clientId: CLIENT,
      pickPack: 0,
      additional: 0,
      packageCost: 0,
      shipping: 20.83,
      packageId: PKG_STAMPED,
      reason: 'stale bundle full resend',
    });
    const afterJ = await snapshot(h);
    check('J — a source-less stale full-resend payload is refused with zero mutation', () => {
      // This is the exact shape that waived July's prep fees. Without a mandatory
      // discriminator it would be read as a deliberate manual edit and applied.
      eq(resJ.status, 400, `body ${JSON.stringify(resJ.body)}`);
      assertUnchanged(beforeJ, afterJ, 'J');
    });

    // ─── K/L/M — unresolvable box pricing, 422 and zero mutation ─────────────
    for (const [label, clientId, packageId, orderId] of [
      ['K — unknown package', CLIENT, PKG_UNKNOWN, ORDER],
      ['L — client has no box pricing', CLIENT_NO_PRICING, PKG_STAMPED, ORDER_NO_PRICING],
      ['M — no configured price for this box', CLIENT, PKG_UNPRICED, ORDER],
    ] as const) {
      await reset(h);
      const before = await snapshot(h);
      const res = await patch(h, { source: 'bulk_import', clientId, packageId, reason: 'unpriceable' }, orderId);
      const after = await snapshot(h);
      check(`${label} fails closed with 422 and commits nothing`, () => {
        eq(res.status, 422, `body ${JSON.stringify(res.body)}`);
        eq(res.body.error, 'BULK_IMPORT_PACKAGE_PRICE_UNRESOLVED', 'stable error code');
        assertUnchanged(before, after, label);
      });
    }

    // ─── N — rollback AFTER a tentative write ────────────────────────────────
    await reset(h);
    const beforeN = await snapshot(h);
    const resN = await patch(h, {
      source: 'bulk_import',
      clientId: CLIENT,
      packageId: PKG_UNPRICED,
      shipping: 77.77,
      reason: 'shipping writes first, then the box fails',
    });
    const afterN = await snapshot(h);
    check('N — a tentative shipping write is rolled back when the box cannot be priced', () => {
      // The editable-lines loop writes shipping BEFORE the package-cost block runs,
      // so this proves the transaction actually rolls back rather than the error
      // merely being raised before the first mutation.
      eq(resN.status, 422, `body ${JSON.stringify(resN.body)}`);
      assertUnchanged(beforeN, afterN, 'N');
    });

    // ─── O — the required audit insert fails after line/sidecar work ─────────
    await reset(h);
    await h.query(`alter table audit_log add constraint ps499_block_line_edit
      check (action <> 'invoice_line_edit')`);
    const beforeO = await snapshot(h);
    const resO = await patch(h, { source: 'bulk_import', clientId: CLIENT, shipping: 55.55, reason: 'audit must fail' });
    const afterO = await snapshot(h);
    await h.query(`alter table audit_log drop constraint ps499_block_line_edit`);
    check('O — no line or sidecar can commit without its required audit row', () => {
      if (resO.status === 200) throw new Error('the request must not succeed when the required audit insert fails');
      assertUnchanged(beforeO, afterO, 'O');
    });

    // ─── P — finalized/invoiced lockdown ─────────────────────────────────────
    // Runs LAST and resets only once: production triggers refuse both to truncate
    // and to un-invoice finalized lines, so once this order is finalized it stays
    // that way for the rest of the process. All three modes are refused, so a single
    // before/after pair still proves zero mutation across them.
    await reset(h);
    await h.query(`update billing_line_items set invoiced = true where order_id = ${ORDER}`);
    const beforeP = await snapshot(h);
    const modesP = [
      ['P — shipping-only', { source: 'bulk_import', clientId: CLIENT, shipping: 20.83, reason: 'ps499 boundary' }],
      ['P — box-only', { source: 'bulk_import', clientId: CLIENT, packageId: PKG_OTHER, reason: 'ps499 boundary' }],
      ['P — combined', { source: 'bulk_import', clientId: CLIENT, packageId: PKG_OTHER, shipping: 20.83, reason: 'ps499 boundary' }],
    ] as const;

    for (const [label, body] of modesP) {
      const res = await patch(h, body as PatchBody);
      check(`${label} against a finalized order is refused`, () => {
        if (res.status === 200) throw new Error('a finalized order must not be editable by a bulk import');
      });
    }

    const afterP = await snapshot(h);
    check('P — no bulk mode mutated a finalized order', () => {
      assertUnchanged(beforeP, afterP, 'P');
    });
  } finally {
    await h.close();
  }

  if (failures) {
    console.error(`\nFAIL ps-499 route integration (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS ps-499 route integration');
}

await main();
