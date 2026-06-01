#!/usr/bin/env tsx
/**
 * Smoke test for the ShipStation parity helpers added in Passes 1-3.
 * Pure-logic tests — no network, no DB, no ShipStation API.
 *
 * Run: npx tsx scripts/smoke-shipstation-parity.ts
 *
 * Covers:
 *  - isBlockedRate: v2's exact 7 service codes + 8 package types + NAME_RE
 *  - MEDIA_MAIL_ALLOWED_STORES: media_mail un-blocked for store 376759 only
 *  - normalizeOrderBestRateDto: snake_case input → canonical camelCase
 *  - assertPersistedOrderBestRateDto: throws on missing required fields
 *  - normalizeOrderSelectedRateDto: same canonicalization for selected rate
 *
 * Does NOT cover (needs server + ShipStation API + JWT):
 *  - Real /v2/rates/estimate calls
 *  - Real label creation / void / return
 *  - 3-pass order sync timing
 *  - V2 shipment enrichment matching
 *  - Credential resolution with rate_source_client_id (needs DB)
 */

import {
  isBlockedRate,
  BLOCKED_SERVICE_CODES,
  BLOCKED_PACKAGE_TYPES,
  MEDIA_MAIL_ALLOWED_STORES,
} from '../src/services/rates';
import { evaluateShippingServiceEligibility } from '../src/lib/shipping-service-eligibility';
import {
  normalizeOrderBestRateDto,
  assertPersistedOrderBestRateDto,
  normalizeOrderSelectedRateDto,
} from '../src/services/order-rate-dto';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    fail += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name} — ${msg}`);
  }
}

function expect<T>(actual: T): {
  toBe: (expected: T) => void;
  toEqual: (expected: T) => void;
  toThrow: () => void;
  toContain: (val: unknown) => void;
  toBeUndefined: () => void;
} {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    },
    toThrow() {
      if (typeof actual !== 'function') throw new Error('actual must be a function');
      let threw = false;
      try {
        (actual as () => unknown)();
      } catch {
        threw = true;
      }
      if (!threw) throw new Error('expected to throw but did not');
    },
    toContain(val: unknown) {
      if (actual instanceof Set) {
        if (!actual.has(val as never)) {
          throw new Error(`expected Set to contain ${JSON.stringify(val)}`);
        }
      } else if (Array.isArray(actual)) {
        if (!actual.includes(val as never)) {
          throw new Error(`expected array to contain ${JSON.stringify(val)}`);
        }
      } else {
        throw new Error('expected Set or array');
      }
    },
    toBeUndefined() {
      if (actual !== undefined) {
        throw new Error(`expected undefined, got ${JSON.stringify(actual)}`);
      }
    },
  };
}

// ─── BLOCKED_SERVICE_CODES — exact v2 list ────────────────────────────────
console.log('\n\x1b[1mBLOCKED_SERVICE_CODES\x1b[0m');

test('includes the global USPS service blocks only', () => {
  const expected = [
    'usps_media_mail',
    'usps_first_class_mail',
    'usps_library_mail',
    'usps_parcel_select',
    'usps_parcel_select_lightweight',
  ];
  for (const code of expected) expect(BLOCKED_SERVICE_CODES).toContain(code);
  expect(BLOCKED_SERVICE_CODES.size).toBe(5);
});

test('does NOT include plain usps_priority_mail (v2 parity)', () => {
  if (BLOCKED_SERVICE_CODES.has('usps_priority_mail')) {
    throw new Error('usps_priority_mail is in the blocked set — v2 does not block it');
  }
});

// ─── BLOCKED_PACKAGE_TYPES ───────────────────────────────────────────────
console.log('\n\x1b[1mBLOCKED_PACKAGE_TYPES\x1b[0m');

test('includes all 8 v2 flat-rate + regional-rate types', () => {
  const expected = [
    'flat_rate_envelope',
    'flat_rate_legal_envelope',
    'flat_rate_padded_envelope',
    'small_flat_rate_box',
    'medium_flat_rate_box',
    'large_flat_rate_box',
    'regional_rate_box_a',
    'regional_rate_box_b',
  ];
  for (const t of expected) expect(BLOCKED_PACKAGE_TYPES).toContain(t);
  expect(BLOCKED_PACKAGE_TYPES.size).toBe(8);
});

// ─── isBlockedRate ────────────────────────────────────────────────────────
console.log('\n\x1b[1misBlockedRate()\x1b[0m');

test('blocks usps_media_mail by default', () => {
  expect(isBlockedRate({ service_code: 'usps_media_mail' })).toBe(true);
});

test('un-blocks usps_media_mail for store 376759 (allowlist)', () => {
  expect(isBlockedRate({ service_code: 'usps_media_mail' }, 376759)).toBe(false);
});

test('blocks usps_media_mail for a different store', () => {
  expect(isBlockedRate({ service_code: 'usps_media_mail' }, 1)).toBe(true);
});

test('does NOT globally block UPS SurePost; PS-057 blocks it only for HUGRAB', () => {
  expect(isBlockedRate({ service_code: 'ups_surepost_less_than_1_lb' })).toBe(false);
  expect(
    evaluateShippingServiceEligibility(
      { clientId: 4, storeId: 378060 },
      { carrierCode: 'ups', serviceCode: 'ups_surepost_less_than_1_lb', serviceName: 'UPS Ground Saver (<1 lb)' },
    ).allowed,
  ).toBe(false);
  expect(
    evaluateShippingServiceEligibility(
      { clientId: 99, storeId: 1 },
      { carrierCode: 'ups', serviceCode: 'ups_surepost_less_than_1_lb', serviceName: 'UPS Ground Saver (<1 lb)' },
    ).allowed,
  ).toBe(true);
});

test('blocks flat_rate_envelope by package_type', () => {
  expect(isBlockedRate({ package_type: 'flat_rate_envelope' })).toBe(true);
});

test('blocks by service_type name (matches /flat-rate|box/i)', () => {
  expect(isBlockedRate({ service_type: 'USPS Flat Rate Box' })).toBe(true);
});

test('does NOT block usps_priority_mail (v2 parity — v4 regex was overbroad)', () => {
  expect(isBlockedRate({ service_code: 'usps_priority_mail' })).toBe(false);
});

test('does NOT block ups_ground', () => {
  expect(isBlockedRate({ service_code: 'ups_ground' })).toBe(false);
});

// ─── MEDIA_MAIL_ALLOWED_STORES ────────────────────────────────────────────
console.log('\n\x1b[1mMEDIA_MAIL_ALLOWED_STORES\x1b[0m');

test('contains exactly one entry (v2 parity: storeId 376759)', () => {
  expect(MEDIA_MAIL_ALLOWED_STORES.size).toBe(1);
  expect(MEDIA_MAIL_ALLOWED_STORES).toContain(376759);
});

// ─── normalizeOrderBestRateDto ────────────────────────────────────────────
console.log('\n\x1b[1mnormalizeOrderBestRateDto()\x1b[0m');

test('canonicalizes a valid camelCase best-rate payload', () => {
  // Matches v2's order-rate-dto.ts contract: input is already camelCase
  // (upstream unwraps ShipStation's snake_case raw payload). Helper's job
  // is to shape-validate + fill defaults + reject junk.
  const out = normalizeOrderBestRateDto({
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    serviceName: 'USPS Ground Advantage',
    shipmentCost: 5.42,
    carrierNickname: 'USPS Chase x7439',
  });
  if (!out) throw new Error('returned null for valid input');
  expect(out.carrierCode).toBe('stamps_com');
  expect(out.serviceCode).toBe('usps_ground_advantage');
  expect(out.shipmentCost).toBe(5.42);
});

test('returns null for empty input (no meaningful fields)', () => {
  expect(normalizeOrderBestRateDto({})).toBe(null as never);
});

test('returns null for null/undefined input', () => {
  expect(normalizeOrderBestRateDto(null)).toBe(null as never);
  expect(normalizeOrderBestRateDto(undefined)).toBe(null as never);
});

test('throws on non-record input (type safety)', () => {
  expect(() => normalizeOrderBestRateDto('not-an-object' as never)).toThrow();
});

// ─── assertPersistedOrderBestRateDto ──────────────────────────────────────
console.log('\n\x1b[1massertPersistedOrderBestRateDto()\x1b[0m');

test('throws when carrierCode/carrier_code is missing', () => {
  expect(() =>
    assertPersistedOrderBestRateDto({ service_code: 'ups_ground' } as never),
  ).toThrow();
});

test('throws when serviceCode/service_code is missing', () => {
  expect(() =>
    assertPersistedOrderBestRateDto({ carrier_code: 'ups' } as never),
  ).toThrow();
});

test('accepts a canonical best-rate dto', () => {
  // Should NOT throw
  assertPersistedOrderBestRateDto({
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    shippingAmount: 12.5,
    carrierNickname: 'UPS Main',
  } as never);
});

// ─── normalizeOrderSelectedRateDto ────────────────────────────────────────
console.log('\n\x1b[1mnormalizeOrderSelectedRateDto()\x1b[0m');

test('canonicalizes a valid selected-rate payload (camelCase)', () => {
  const out = normalizeOrderSelectedRateDto({
    carrierCode: 'fedex',
    serviceCode: 'fedex_ground',
    shipmentCost: 9.99,
  });
  if (!out) throw new Error('returned null for valid input');
  expect(out.carrierCode).toBe('fedex');
  expect(out.serviceCode).toBe('fedex_ground');
});

test('returns null for empty selected-rate input', () => {
  expect(normalizeOrderSelectedRateDto({})).toBe(null as never);
});

// ─── Summary ──────────────────────────────────────────────────────────────
console.log('');
console.log(`\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
