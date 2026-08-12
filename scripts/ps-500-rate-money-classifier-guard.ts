#!/usr/bin/env tsx
/**
 * PS-500 — rate money is classified before anything defaults it.
 *
 * The Rate Browser seeded a selectable row from reconstructed money:
 *   otherCost    = ... ?? 0                          absent add-ons became $0.00
 *   shipmentCost = alias ?? Math.max(0, amount - otherCost)
 *                                                    a TOTAL became a COMPONENT,
 *                                                    and a contradiction was
 *                                                    clamped to a plausible 0
 * The same defect exists in the backend it reads from — `?? 0` in
 * shipping-rate-money-normalizer.ts:73/126 and at three sites in
 * order-rate-dto.ts (:448, :474, :566), each also accepting `amount` as a
 * component.
 *
 * `classifyRateMoney` runs first and never substitutes, so "the backend sent
 * nothing" stays distinguishable from "the backend sent zero".
 *
 * Exercises the REAL exported classifier and the real browse producer — no
 * hand-built stand-ins for the code under test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyRateMoney,
  RATE_MONEY_UNAVAILABLE_MESSAGE,
} from '../src/services/shipping-workflow/shipping-rate-money-classifier';
import { stampRateBrowserDisplayAliases } from '../src/services/rate-browser-display-fields';
import { redactRateBrowserMoney } from '../src/services/rate-browser-money-redaction';

let checks = 0;
const check = (label: string, fn: () => void) => {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
};

console.log('PS-500 rate money classifier guard');

// ── Complete ────────────────────────────────────────────────────────────────
check('a complete tuple is complete, with values verbatim', () => {
  const v = classifyRateMoney({ shipmentCost: 8.25, otherCost: 1.5 });
  assert.equal(v.rateMoneyComplete, true);
  assert.equal(v.shipmentCost.value, 8.25);
  assert.equal(v.otherCost.value, 1.5);
  assert.equal(v.rateMoneyUnavailableReason, null);
  assert.equal(v.rateMoneyUnavailableMessage, null);
});

check('snake_case and raw carry the same authority', () => {
  assert.equal(classifyRateMoney({ shipment_cost: 8.25, other_cost: 0 }).rateMoneyComplete, true);
  assert.equal(classifyRateMoney({ raw: { shipmentCost: 8.25, otherCost: 0 } }).rateMoneyComplete, true);
});

// ── Field-specific zero — the rule `?? 0` erased in BOTH directions ──────────
check('otherCost 0 is VALID — most rates have no add-ons', () => {
  const v = classifyRateMoney({ shipmentCost: 8.25, otherCost: 0 });
  assert.equal(v.rateMoneyComplete, true, 'an explicit zero add-on must not read as missing');
  assert.equal(v.otherCost.value, 0);
  assert.equal(v.otherCost.provenance, 'present');
});

check('shipmentCost 0 is NOT complete — a shipment cannot cost nothing', () => {
  const v = classifyRateMoney({ shipmentCost: 0, otherCost: 0 });
  assert.equal(v.rateMoneyComplete, false);
  assert.equal(v.rateMoneyUnavailableReason, 'shipment_cost_not_positive');
});

check('a negative shipmentCost is not complete', () => {
  assert.equal(classifyRateMoney({ shipmentCost: -1, otherCost: 0 }).rateMoneyComplete, false);
});

// ── Absent is not zero ──────────────────────────────────────────────────────
check('absent otherCost is ABSENT, never zero', () => {
  const v = classifyRateMoney({ shipmentCost: 8.25 });
  assert.equal(v.rateMoneyComplete, false);
  assert.equal(v.otherCost.provenance, 'absent');
  assert.equal(v.otherCost.value, null, 'must not be defaulted to 0');
  assert.equal(v.rateMoneyUnavailableReason, 'other_cost_absent');
});

check('absent shipmentCost is absent', () => {
  const v = classifyRateMoney({ otherCost: 0 });
  assert.equal(v.rateMoneyComplete, false);
  assert.equal(v.shipmentCost.provenance, 'absent');
  assert.equal(v.rateMoneyUnavailableReason, 'shipment_cost_absent');
});

// ── A total is not a component ───────────────────────────────────────────────
check('`amount` alone NEVER satisfies the shipment component', () => {
  // The headline defect: a TOTAL accepted as a COMPONENT, then reconstructed.
  const v = classifyRateMoney({ amount: 9.75, otherCost: 1.5 });
  assert.equal(v.rateMoneyComplete, false);
  assert.equal(v.shipmentCost.provenance, 'absent');
  assert.notEqual(v.shipmentCost.value, 9.75, 'a total must not become the component');
  assert.notEqual(v.shipmentCost.value, 8.25, 'and must not be reconstructed as amount - otherCost');
});

check('totalCost and cost do not satisfy it either', () => {
  assert.equal(classifyRateMoney({ totalCost: 9.75, otherCost: 0 }).rateMoneyComplete, false);
  assert.equal(classifyRateMoney({ cost: 9.75, otherCost: 0 }).rateMoneyComplete, false);
});

// ── Contradiction is surfaced, not clamped ──────────────────────────────────
check('a negative otherCost is reported, not clamped to zero', () => {
  const v = classifyRateMoney({ shipmentCost: 8.25, otherCost: -2 });
  assert.equal(v.rateMoneyComplete, false);
  assert.equal(v.rateMoneyUnavailableReason, 'other_cost_negative');
  assert.equal(v.otherCost.value, -2, 'the contradictory value is preserved for diagnosis');
});

check('a DOCUMENTED total contradicting its components fails closed', () => {
  const v = classifyRateMoney({ shipmentCost: 8, otherCost: 5, totalCost: 4 });
  assert.equal(v.rateMoneyComplete, false, '8 + 5 cannot total 4');
  assert.equal(v.rateMoneyUnavailableReason, 'total_contradicts_components');
  assert.equal(classifyRateMoney({ shipmentCost: 8, otherCost: 5, selectedRateCost: 4 }).rateMoneyUnavailableReason,
    'total_contradicts_components');
});

check('a total agreeing with its components stays complete', () => {
  assert.equal(classifyRateMoney({ shipmentCost: 8.25, otherCost: 1.5, totalCost: 9.75 }).rateMoneyComplete, true);
  // float noise must not read as contradiction
  assert.equal(classifyRateMoney({ shipmentCost: 8.25, otherCost: 1.5, totalCost: 9.7499999 }).rateMoneyComplete, true);
});

check('a bare `amount` is NOT read as a total', () => {
  // Regression. `amount` was in TOTAL_KEYS, so a correct row whose `amount`
  // carried the shipment component (which is how
  // shipping-rate-money-normalizer.ts:123 reads it) contradicted itself and was
  // blocked. Providers use `amount` inconsistently; only documented totals count.
  const v = classifyRateMoney({ shipmentCost: 8.25, otherCost: 1.5, amount: 8.25 });
  assert.equal(v.rateMoneyComplete, true, 'an ambiguous `amount` must not manufacture a contradiction');
});

// ── The provider shape — what the first version could not read at all ────────
// src/lib/shipstation/types.ts: shipping_amount is REQUIRED, the three add-ons
// are OPTIONAL. Knowing only the flat keys classified every live rate
// `shipment_cost_absent` and took the whole browse path unavailable.
check('shipping_amount.amount is the shipment component', () => {
  const v = classifyRateMoney({
    shipping_amount: { currency: 'usd', amount: 8.25 },
    other_amount: { currency: 'usd', amount: 0 },
    confirmation_amount: { currency: 'usd', amount: 0 },
    insurance_amount: { currency: 'usd', amount: 0 },
  });
  assert.equal(v.rateMoneyComplete, true, 'a live rate with explicit zero add-ons is selectable');
  assert.equal(v.shipmentCost.value, 8.25);
  assert.equal(v.otherCost.value, 0);
});

check('the structured add-ons are summed', () => {
  const v = classifyRateMoney({
    shipping_amount: { currency: 'usd', amount: 8.25 },
    insurance_amount: { currency: 'usd', amount: 1.5 },
  });
  assert.equal(v.rateMoneyComplete, true);
  assert.equal(v.shipmentCost.value, 8.25);
  assert.equal(v.otherCost.value, 1.5, 'insurance is an add-on, not the shipment cost');
  assert.equal(v.shipmentCost.value! + v.otherCost.value!, 9.75);
});

check('all three add-ons sum, and cents do not drift', () => {
  const v = classifyRateMoney({
    shipping_amount: { amount: 8.25 },
    other_amount: { amount: 0.1 },
    confirmation_amount: { amount: 0.2 },
    insurance_amount: { amount: 1.5 },
  });
  assert.equal(v.rateMoneyComplete, true);
  assert.equal(v.otherCost.value, 1.8, '0.1 + 0.2 + 1.5 must not land on 1.8000000000000003');
});

check('a structured row carrying no add-on fields is complete', () => {
  // The add-ons are optional in the contract, so an omitted one means the
  // carrier did not charge it. Reading the contract, not defaulting.
  const v = classifyRateMoney({ shipping_amount: { currency: 'usd', amount: 8.25 } });
  assert.equal(v.rateMoneyComplete, true);
  assert.equal(v.otherCost.value, 0);
  assert.match(String(v.otherCost.source), /no add-on fields carried/,
    'the reason this is zero must stay auditable, not look like a supplied value');
});

check('a FLAT row silent about add-ons is still incomplete', () => {
  // The concession above is scoped to the provider convention. In the flat
  // shape, silence is genuinely unknown — this is the original `?? 0` defect.
  assert.equal(classifyRateMoney({ shipmentCost: 8.25 }).rateMoneyUnavailableReason, 'other_cost_absent');
});

check('a missing shipping_amount is still absent', () => {
  const v = classifyRateMoney({ insurance_amount: { amount: 1.5 }, amount: 9.75 });
  assert.equal(v.rateMoneyComplete, false);
  assert.equal(v.rateMoneyUnavailableReason, 'shipment_cost_absent');
});

check('an unparseable or negative provider component is refused', () => {
  assert.equal(
    classifyRateMoney({ shipping_amount: { amount: 'n/a' } }).rateMoneyUnavailableReason,
    'shipment_cost_invalid');
  assert.equal(
    classifyRateMoney({ shipping_amount: { amount: 8.25 }, insurance_amount: { amount: 'n/a' } })
      .rateMoneyUnavailableReason,
    'other_cost_invalid');
  assert.equal(
    classifyRateMoney({ shipping_amount: { amount: 8.25 }, insurance_amount: { amount: -2 } })
      .rateMoneyUnavailableReason,
    'other_cost_negative');
  assert.equal(
    classifyRateMoney({ shipping_amount: { amount: 8.25 }, other_amount: { amount: 5 }, insurance_amount: { amount: -2 } })
      .rateMoneyUnavailableReason,
    'other_cost_negative',
    'a negative line must not be netted away by a larger positive sibling');
});

check('a flattened scalar provider field carries the same authority', () => {
  // Some payloads drop the { currency, amount } wrapper. The wrapper is
  // presentation; the field name is the provenance.
  const v = classifyRateMoney({ shipping_amount: 8.25, insurance_amount: 1.5 });
  assert.equal(v.rateMoneyComplete, true);
  assert.equal(v.shipmentCost.value, 8.25);
  assert.equal(v.otherCost.value, 1.5);
});

check('the add-on sum rounds through the money owner', () => {
  // roundMoney is the repo's single cent-rounding owner (audit-money-rounding).
  const v = classifyRateMoney({ shipping_amount: 8.25, other_amount: 0.07, confirmation_amount: 0.08 });
  assert.equal(v.otherCost.value, 0.15, '0.07 + 0.08 must not land on 0.15000000000000002');
});

check('flat keys still win over the structured shape', () => {
  const v = classifyRateMoney({ shipmentCost: 8.25, otherCost: 0, shipping_amount: { amount: 99 } });
  assert.equal(v.shipmentCost.value, 8.25, 'a normalized row is already authoritative');
});

// ── Unusable is different from silent ───────────────────────────────────────
check('an unparseable value is INVALID, not absent', () => {
  const v = classifyRateMoney({ shipmentCost: 'n/a', otherCost: 0 });
  assert.equal(v.shipmentCost.provenance, 'invalid');
  assert.equal(v.rateMoneyUnavailableReason, 'shipment_cost_invalid');
});

check('numeric strings are accepted', () => {
  const v = classifyRateMoney({ shipmentCost: '8.25', otherCost: '0' });
  assert.equal(v.rateMoneyComplete, true);
  assert.equal(v.shipmentCost.value, 8.25);
});

// ── Provenance keeps the answer auditable ───────────────────────────────────
check('provenance records which key answered', () => {
  assert.equal(classifyRateMoney({ shipmentCost: 8.25, otherCost: 0 }).shipmentCost.source, 'shipmentCost');
  assert.equal(classifyRateMoney({ raw: { shipmentCost: 8.25 }, otherCost: 0 }).shipmentCost.source, 'raw.shipmentCost');
});

// ── The operator-facing message is backend-owned ─────────────────────────────
check('every incomplete verdict carries the same backend-owned message', () => {
  for (const payload of [{}, { amount: 9.75 }, { shipmentCost: 0, otherCost: 0 }, { shipmentCost: 8.25 }]) {
    const v = classifyRateMoney(payload);
    assert.equal(v.rateMoneyComplete, false);
    assert.equal(v.rateMoneyUnavailableMessage, RATE_MONEY_UNAVAILABLE_MESSAGE);
    assert(v.rateMoneyUnavailableReason, 'a machine-readable reason must accompany the message');
  }
  assert.equal(RATE_MONEY_UNAVAILABLE_MESSAGE, 'Saved rate unavailable — browse again');
});

check('garbage input does not throw', () => {
  for (const payload of [null, undefined, 'x', 7, []]) {
    assert.equal(classifyRateMoney(payload).rateMoneyComplete, false);
  }
});

// ── BEHAVIOURAL: the common live/cache browse boundary ──────────────────────
// Not source assertions. This runs a provider-shaped row through the real
// producer, because the first attempt at PS-500 wired only the persisted seed
// and Hermes reproduced a live candidate laundering a TOTAL into a COMPONENT
// while carrying no verdict at all.
check('the browse producer stamps the verdict on a live row', () => {
  const [row] = stampRateBrowserDisplayAliases([
    { amount: 9.75, otherCost: 1.5, carrierCode: 'ups', serviceCode: 'ups_ground' },
  ]) as Array<Record<string, unknown>>;
  // The alias stamper still derives a displayable shipmentCost — that is legacy
  // display normalization and is deliberately preserved. What must NOT happen is
  // that derived number being presented as complete money.
  assert.equal(row.rateMoneyComplete, false,
    'a live row with only `amount` must not claim complete money');
  assert.equal(row.rateMoneyUnavailableReason, 'shipment_cost_absent');
  assert.equal(row.rateMoneyUnavailableMessage, RATE_MONEY_UNAVAILABLE_MESSAGE);
});

check('a complete live row is stamped complete', () => {
  const [row] = stampRateBrowserDisplayAliases([
    { shipmentCost: 8.25, otherCost: 0, carrierCode: 'ups', serviceCode: 'ups_ground' },
  ]) as Array<Record<string, unknown>>;
  assert.equal(row.rateMoneyComplete, true);
  assert.equal(row.rateMoneyUnavailableReason, null);
});

check('a refreshed live rate set is selectable across carriers', () => {
  // The regression this replaces: every one of these classified
  // `shipment_cost_absent`, so Browse Rates showed Unavailable on every row and
  // no carrier could be selected at all.
  const live = [
    { carrier_code: 'ups', service_code: 'ups_ground',
      shipping_amount: { currency: 'usd', amount: 12.4 },
      other_amount: { currency: 'usd', amount: 0 },
      confirmation_amount: { currency: 'usd', amount: 0 },
      insurance_amount: { currency: 'usd', amount: 0 } },
    { carrier_code: 'usps', service_code: 'usps_priority_mail',
      shipping_amount: { currency: 'usd', amount: 8.25 },
      insurance_amount: { currency: 'usd', amount: 1.5 } },
    { carrier_code: 'fedex', service_code: 'fedex_2day',
      shipping_amount: { currency: 'usd', amount: 21.07 } },
  ];
  const rows = stampRateBrowserDisplayAliases(live) as Array<Record<string, unknown>>;
  for (const [index, row] of rows.entries()) {
    assert.equal(row.rateMoneyComplete, true,
      `${live[index].carrier_code} must be selectable — reason: ${row.rateMoneyUnavailableReason}`);
    assert.equal(row.rateMoneyUnavailableReason, null);
  }
});

check('an incomplete row in a live set is the ONLY one blocked', () => {
  const rows = stampRateBrowserDisplayAliases([
    { carrier_code: 'ups', shipping_amount: { amount: 12.4 } },
    { carrier_code: 'usps', amount: 9.75, otherCost: 1.5 },
  ]) as Array<Record<string, unknown>>;
  assert.equal(rows[0].rateMoneyComplete, true, 'a valid neighbour must not be dragged down');
  assert.equal(rows[1].rateMoneyComplete, false);
  assert.equal(rows[1].rateMoneyUnavailableReason, 'shipment_cost_absent');
});

check('the verdict survives money redaction', () => {
  // Redaction runs AFTER stamping and nulls internal money for restricted
  // viewers. The verdict is a boolean about provenance, not a money value — if
  // it were ever added to that key set it would null out, the frontend would
  // read it as a legacy untrusted row, and those viewers would get the same
  // browse outage that only they could see.
  const [row] = redactRateBrowserMoney(stampRateBrowserDisplayAliases([
    { carrier_code: 'ups', shipping_amount: { currency: 'usd', amount: 8.25 }, other_amount: { currency: 'usd', amount: 0 } },
  ])) as Array<Record<string, unknown>>;
  assert.equal(row.rateMoneyComplete, true,
    'redacting internal money must not make a valid rate unavailable');
});

check('the verdict survives the alias stamper it wraps', () => {
  // Applied to the RESULT, so stampPurchaseCustomerRateAliases — the code that
  // derives purchaseShipmentCost = purchaseTotal - otherCost — cannot overwrite
  // it back to a complete-looking row.
  const [row] = stampRateBrowserDisplayAliases([
    { amount: 12, otherCost: 2, purchaseTotal: 12 },
  ]) as Array<Record<string, unknown>>;
  assert.equal(row.rateMoneyComplete, false, 'derived purchase money must not imply completeness');
});

check('a single (non-array) bestRate is stamped too', () => {
  const row = stampRateBrowserDisplayAliases({ amount: 9.75, otherCost: 1.5 }) as Record<string, unknown>;
  assert.equal(row.rateMoneyComplete, false, 'bestRate goes through the same boundary');
});

check('nested secondBestRate carries its own verdict', () => {
  const row = stampRateBrowserDisplayAliases({
    shipmentCost: 8.25, otherCost: 0,
    secondBestRate: { amount: 9.75, otherCost: 1.5 },
  }) as Record<string, unknown>;
  assert.equal(row.rateMoneyComplete, true);
  const second = row.secondBestRate as Record<string, unknown>;
  assert.equal(second.rateMoneyComplete, false, 'the nested row is classified on its own merits');
});

// ── Wiring: the verdict reaches the DTO, and the seed obeys it ──────────────
const dtoSource = readFileSync('src/services/order-rate-dto.ts', 'utf8');
const modalSource = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');

check('the DTO classifies BEFORE its own defaulting', () => {
  assert.match(dtoSource, /classifyRateMoney\(record\)/, 'must classify the raw record');
  const classifyAt = dtoSource.indexOf('const verdict = classifyRateMoney(record)');
  const dtoAt = dtoSource.indexOf('const rate: OrderBestRateDto = {');
  assert(classifyAt !== -1 && dtoAt !== -1 && classifyAt < dtoAt,
    'classification must happen before the DTO object is built');
});

check('the DTO exposes the three backend-owned fields', () => {
  for (const field of ['rateMoneyComplete', 'rateMoneyUnavailableReason', 'rateMoneyUnavailableMessage']) {
    assert.match(dtoSource, new RegExp(`${field}:`), `OrderBestRateDto must carry ${field}`);
  }
});

check('the seed refuses incomplete money before building a row', () => {
  const start = modalSource.indexOf('function buildOrderBestRateSeed');
  const body = modalSource.slice(start, modalSource.indexOf('\n}', start));
  assert.match(body, /if \(!rateMoneyIsComplete\(bestRate\)\) return null/,
    'an incomplete saved rate must produce NO seeded row — a seeded row is selectable');
});

check('the frontend no longer reconstructs shipment cost', () => {
  const start = modalSource.indexOf('function buildOrderBestRateSeed');
  const body = modalSource.slice(start, modalSource.indexOf('\n}', start));
  // Strip comments first. The block documents the removed expressions by name,
  // and a guard that trips on its own explanation would force the next engineer
  // to delete the reasoning to get green — exactly backwards.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(!/Math\.max\(0,\s*amount/.test(code), 'the contradiction clamp must be gone');
  assert(!/amount\s*-\s*otherCost/.test(code), 'amount - otherCost reconstruction must be gone');
  assert(!/otherCost\s*\)\s*\?\?\s*0/.test(code), 'otherCost must not default to 0');
});

check('legacy rows with no verdict are treated as incomplete', () => {
  // A row persisted before the stamp cannot be shown to be sound, and this seed
  // feeds Apply -> persisted best_rate_json -> Create Label.
  assert.match(modalSource, /record\.rateMoneyComplete === true/,
    'only an explicit true may pass; absent must not be trusted');
});

// ── Availability consumes the verdict — the path a mutation matrix found bare ──
// These three checks exist because the first 28 passed while `rateBlockedReason`
// could be stripped of its money check entirely. The fix was present; nothing
// defended it. A guard that documents a fix instead of defending it is a guard
// that will be green on the day the bug comes back.
check('availability consults the money verdict FIRST', () => {
  const start = modalSource.indexOf('function rateBlockedReason(');
  const body = modalSource.slice(start, modalSource.indexOf('\n}', start));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const moneyAt = code.indexOf('savedRateUnavailableMessage(rate)');
  const legacyAt = code.indexOf('rateBrowserUnavailableReason(');
  assert(moneyAt !== -1,
    'availability must consult money completeness — the reason owner it delegates to covers ' +
    'proof, freshness and eligibility, and has never inspected whether the money was supplied');
  assert(legacyAt !== -1, 'the existing reason owner must still run for every other cause');
  assert(moneyAt < legacyAt,
    'money must be read BEFORE the downstream reason, or an unpriceable row gets described ' +
    'by an unrelated cause and the operator is told the wrong thing');
  assert(/if\s*\(moneyReason\)\s*return moneyReason/.test(code),
    'the verdict must short-circuit — computing it and falling through leaves the row selectable');
});

check('every emitting path gates on that one boundary', () => {
  // handleRateClick -> onApplyRate is the manual Apply. toAppliedRate -> the
  // auto-best emission that persists best_rate_json. Both feed Create Label.
  for (const [fn, emit] of [
    ['function handleRateClick', 'onApplyRate({'],
    ['function toAppliedRate', 'return {'],
  ] as const) {
    const start = modalSource.indexOf(fn);
    assert(start !== -1, `${fn} must exist — it is a named boundary in this contract`);
    const body = modalSource.slice(start, modalSource.indexOf('\n  }', start));
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The gate must be an early RETURN, not merely a call. `void
    // isBackendUnavailableRate(...)` keeps the call site, keeps the ordering,
    // and ships the bug — and a refactor that "kept the call" reads as safe in
    // review. Assert the control flow, not the presence.
    const gate = /if\s*\(\s*isBackendUnavailableRate\([^)]*\)\s*\)\s*return/.exec(code);
    const emitAt = code.indexOf(emit);
    assert(gate, `${fn} must REFUSE on the availability boundary — consulting it and ` +
      'discarding the answer leaves an unpriceable row selectable');
    assert(emitAt !== -1, `${fn} must still emit on the happy path`);
    assert(gate.index < emitAt, `${fn} must refuse BEFORE it emits, not after`);
  }
});

check('the availability boundary is the one the gate calls', () => {
  // If isBackendUnavailableRate stopped delegating to rateBlockedReason, both
  // gates above would pass while consulting nothing.
  const start = modalSource.indexOf('function isBackendUnavailableRate(');
  const body = modalSource.slice(start, modalSource.indexOf('\n}', start));
  assert(/rateBlockedReason\(/.test(body),
    'the gate must delegate to the reason owner that reads the money verdict');
});

check('the operator sees the backend-owned reason', () => {
  assert.match(modalSource, /data-rate-browser="savedRateUnavailable"/,
    'the refusal must be visible, not silent');
  assert.match(modalSource, /savedRateUnavailableMessage\(order\?\.bestRate\)/);
  assert.equal((modalSource.match(/setSavedRateNotice\(seededBestRate/g) || []).length, 2,
    'both seed call sites must set the notice');
});

console.log(`\nPS-500 classifier guard passed — ${checks} checks.`);
