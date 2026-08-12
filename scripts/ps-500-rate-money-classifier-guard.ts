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
 * Exercises the REAL exported classifier. Hermetic: the module has no imports.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyRateMoney,
  RATE_MONEY_UNAVAILABLE_MESSAGE,
} from '../src/services/shipping-workflow/shipping-rate-money-classifier';
import { stampRateBrowserDisplayAliases } from '../src/services/rate-browser-display-fields';

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

check('an explicit total contradicting its components fails closed', () => {
  const v = classifyRateMoney({ shipmentCost: 8, otherCost: 5, amount: 4 });
  assert.equal(v.rateMoneyComplete, false, '8 + 5 cannot total 4');
  assert.equal(v.rateMoneyUnavailableReason, 'total_contradicts_components');
});

check('a total agreeing with its components stays complete', () => {
  assert.equal(classifyRateMoney({ shipmentCost: 8.25, otherCost: 1.5, amount: 9.75 }).rateMoneyComplete, true);
  // float noise must not read as contradiction
  assert.equal(classifyRateMoney({ shipmentCost: 8.25, otherCost: 1.5, totalCost: 9.7499999 }).rateMoneyComplete, true);
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

check('the operator sees the backend-owned reason', () => {
  assert.match(modalSource, /data-rate-browser="savedRateUnavailable"/,
    'the refusal must be visible, not silent');
  assert.match(modalSource, /savedRateUnavailableMessage\(order\?\.bestRate\)/);
  assert.equal((modalSource.match(/setSavedRateNotice\(seededBestRate/g) || []).length, 2,
    'both seed call sites must set the notice');
});

console.log(`\nPS-500 classifier guard passed — ${checks} checks.`);
