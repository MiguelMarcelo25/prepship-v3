import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectExpeditedShipping,
  normalizeServiceText,
  type ExpeditedTier,
} from '../src/lib/shipping/expedited';

// PS-038 — unit guard for the centralized expedited-shipping detector.
//
// Pins the detection contract that the Orders list API and BOTH frontend
// queues (awaiting + shipped) depend on: positive cases must flag with the
// correct tier/label, negative cases (ground/economy/standard/3-day) must
// NEVER flag, and the frontend mirror (web/src/lib/expedited.ts) must stay
// byte-aligned with this backend source of truth.

type Case = { input: string; tier: ExpeditedTier; label: string };

// --- Normalization ---------------------------------------------------------
assert.equal(normalizeServiceText('UPS® Next-Day Air®'), 'ups next day air');
assert.equal(normalizeServiceText('ups_next_day_air'), 'ups next day air');
assert.equal(normalizeServiceText('FedEx 2Day®'), 'fedex 2day');
assert.equal(normalizeServiceText('  Priority   Overnight  '), 'priority overnight');
assert.equal(normalizeServiceText(null), '');
assert.equal(normalizeServiceText(undefined), '');
assert.equal(normalizeServiceText(123 as unknown as string), '');

// --- POSITIVE cases: must flag with the expected tier + label --------------
const positives: Case[] = [
  // Overnight (top tier)
  { input: 'Priority Overnight', tier: 'overnight', label: 'Overnight' },
  { input: 'Standard Overnight', tier: 'overnight', label: 'Overnight' },
  { input: 'FedEx Overnight', tier: 'overnight', label: 'Overnight' },
  { input: 'UPS Next Day Air Early', tier: 'one_day', label: '1-Day' },
  // One-day / next-day
  { input: 'UPS Next Day Air', tier: 'one_day', label: '1-Day' },
  { input: 'ups_next_day_air', tier: 'one_day', label: '1-Day' },
  { input: 'NextDay', tier: 'one_day', label: '1-Day' },
  { input: '1 Day', tier: 'one_day', label: '1-Day' },
  { input: '1day', tier: 'one_day', label: '1-Day' },
  { input: 'One Day', tier: 'one_day', label: '1-Day' },
  // Two-day
  { input: 'FedEx 2Day', tier: 'two_day', label: '2-Day' },
  { input: '2 Day', tier: 'two_day', label: '2-Day' },
  { input: 'Two Day', tier: 'two_day', label: '2-Day' },
  { input: 'Second Day Air', tier: 'two_day', label: '2-Day' },
  { input: '2nd Day Air', tier: 'two_day', label: '2-Day' },
  { input: 'UPS Express 2 Day', tier: 'two_day', label: '2-Day' },
  // Generic expedited / express
  { input: 'Expedited', tier: 'expedited', label: 'Expedited' },
  { input: 'Priority Mail Express', tier: 'expedited', label: 'Expedited' },
  { input: 'Priority Express', tier: 'expedited', label: 'Expedited' },
  { input: 'FedEx Express', tier: 'expedited', label: 'Expedited' },
];

for (const c of positives) {
  const got = detectExpeditedShipping(c.input);
  assert.equal(got.isExpedited, true, `expected "${c.input}" to be expedited`);
  assert.equal(got.tier, c.tier, `expected "${c.input}" tier=${c.tier}, got ${got.tier}`);
  assert.equal(got.label, c.label, `expected "${c.input}" label=${c.label}, got ${got.label}`);
  assert.ok(got.matchedText, `expected "${c.input}" to record matchedText`);
}

// --- NEGATIVE cases: must NEVER flag ---------------------------------------
const negatives = [
  'UPS Ground',
  'UPS Ground Advantage',
  'USPS Ground Advantage',
  'Ground Saver',
  'FedEx Ground',
  'FedEx Home Delivery',
  'Media Mail',
  'Parcel Select',
  'Parcel Select Ground',
  'First Class',
  'First Class Mail',
  'First Class Package',
  'Standard',
  'Standard Shipping',
  'Economy',
  'Priority Mail', // bare priority is NOT expedited
  'USPS Priority Mail',
  '3 Day Select', // UPS 3-day ground-ish, not 2-day
  'FedEx Express Saver', // FedEx 3-day — shares "express" token but vetoed
  'SmartPost',
  'SurePost',
  '',
];

for (const n of negatives) {
  const got = detectExpeditedShipping(n);
  assert.equal(got.isExpedited, false, `expected "${n}" to NOT be expedited (got tier=${got.tier})`);
  assert.equal(got.tier, null, `expected "${n}" tier=null`);
  assert.equal(got.label, null, `expected "${n}" label=null`);
}

// --- Multi-candidate: most-urgent tier across all candidates wins ----------
assert.equal(
  detectExpeditedShipping('UPS Ground', 'FedEx 2Day').tier,
  'two_day',
  'a 2-day candidate must win over a ground candidate regardless of arg order',
);
assert.equal(
  detectExpeditedShipping('FedEx 2Day', 'Priority Overnight').tier,
  'overnight',
  'overnight must outrank 2-day no matter the arg order',
);
assert.equal(
  detectExpeditedShipping(null, undefined, '', 'UPS Ground').isExpedited,
  false,
  'empty/nullish candidates with only a ground service must not flag',
);
assert.equal(
  detectExpeditedShipping('Expedited', 'UPS Next Day Air').tier,
  'one_day',
  'one-day must outrank generic expedited across candidates',
);

// --- 3-day "Express Saver" veto is scoped, real express still flags --------
assert.equal(detectExpeditedShipping('FedEx Express Saver').isExpedited, false);
assert.equal(detectExpeditedShipping('FedEx Express').isExpedited, true);
assert.equal(detectExpeditedShipping('Express Saver', 'Priority Mail Express').isExpedited, true);

// --- Frontend mirror parity: the duplicated detector must match ------------
// Backend src/ and web/src/ are isolated TS projects (web/tsconfig only
// includes web/src/**), so the algorithm is duplicated by necessity. Pin the
// two copies together by comparing the normalized logic region byte-for-byte.
function extractCoreRegion(source: string): string {
  const start = source.indexOf('export function normalizeServiceText');
  const end = source.indexOf('// Detect expedited shipping from one or more candidate strings');
  assert.ok(start >= 0, 'detector must contain normalizeServiceText export');
  assert.ok(end > start, 'detector must contain the detectExpeditedShipping doc anchor');
  return source.slice(start, end).replace(/\r\n/g, '\n').trim();
}

const backendSrc = readFileSync('src/lib/shipping/expedited.ts', 'utf8');
const frontendSrc = readFileSync('web/src/lib/expedited.ts', 'utf8');
assert.equal(
  extractCoreRegion(frontendSrc),
  extractCoreRegion(backendSrc),
  'web/src/lib/expedited.ts normalization+matcher region must stay byte-identical to src/lib/shipping/expedited.ts (parity guard)',
);

console.log(`PASS expedited detector — ${positives.length} positive, ${negatives.length} negative, multi-candidate + Express-Saver veto + frontend parity`);
