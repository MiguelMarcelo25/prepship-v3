/**
 * PS-258 — print-queue payload parsers extraction guard (BEHAVIORAL + STATIC).
 *
 * Imports the REAL pure functions extracted VERBATIM out of OrdersView.tsx
 * (web/src/components/Views/orders-queue-parsers.ts) and pins their behavior so
 * the extraction is proven importable, pure, and byte-identical in result.
 *
 *  - getQueueableLabelUrl(value): depth-bounded recursive extractor that returns
 *    the first usable label-URL string out of a loose value (direct string, or
 *    nested pdf/href/url/download(_)Url/label(_)Url, max depth 3, cycle-safe),
 *    rejecting empties and the '[object Object]' sentinel → returns null.
 *  - getQueuePayloadEntries(payload): returns the queued-orders entry array out
 *    of a loose print-queue payload (queuedOrders → entries → []). Pure: same
 *    input → same output, no env/state/clock dependence.
 *
 * STATIC pins: OrdersView imports both from the new module and no longer defines
 * either local; the new module exports both and is NOT @ts-nocheck; package.json
 * wires test:ps-258-orders-queue-parsers.
 *
 *   npx tsx scripts/ps-258-orders-queue-parsers-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  getQueueableLabelUrl,
  getQueuePayloadEntries,
} from '../web/src/components/Views/orders-queue-parsers';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const MODULE_PATH = 'web/src/components/Views/orders-queue-parsers.ts';
const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';

// ── getQueueableLabelUrl: direct string passthrough + trim ──
check('a plain http string is returned verbatim',
  getQueueableLabelUrl('https://labels.example/abc.pdf') === 'https://labels.example/abc.pdf');
check('a whitespace-padded string is trimmed',
  getQueueableLabelUrl('  https://labels.example/x.pdf  ') === 'https://labels.example/x.pdf');

// ── getQueueableLabelUrl: nested object key precedence ──
check('pulls a nested .pdf url out of an object',
  getQueueableLabelUrl({ pdf: 'https://labels.example/p.pdf' }) === 'https://labels.example/p.pdf');
check('pulls .label_url (snake) when present',
  getQueueableLabelUrl({ label_url: 'https://labels.example/snake.pdf' }) === 'https://labels.example/snake.pdf');
check('pdf wins over labelUrl (precedence order)',
  getQueueableLabelUrl({ labelUrl: 'https://labels.example/late.pdf', pdf: 'https://labels.example/first.pdf' })
    === 'https://labels.example/first.pdf');
check('recurses one level through a recognized key (url → labelUrl)',
  getQueueableLabelUrl({ url: { labelUrl: 'https://labels.example/deep.pdf' } }) === 'https://labels.example/deep.pdf');
check('does NOT recurse through an unrecognized key (label)',
  getQueueableLabelUrl({ label: { labelUrl: 'https://labels.example/ignored.pdf' } }) === null);

// ── getQueueableLabelUrl: the rejection paths → null ──
check('rejects the [object Object] sentinel',
  getQueueableLabelUrl('[object Object]') === null);
check('rejects an empty string',
  getQueueableLabelUrl('') === null);
check('rejects a whitespace-only string',
  getQueueableLabelUrl('   ') === null);
check('rejects null',
  getQueueableLabelUrl(null) === null);
check('rejects undefined',
  getQueueableLabelUrl(undefined) === null);
check('rejects a number',
  getQueueableLabelUrl(42) === null);
check('rejects an object with no usable url key',
  getQueueableLabelUrl({ foo: 'bar', nope: 123 }) === null);
check('does not descend past depth 3',
  getQueueableLabelUrl({ url: { url: { url: { url: { url: 'https://labels.example/too-deep.pdf' } } } } }) === null);
// cycle safety: a self-referential object must not infinite-loop.
const cyclic: Record<string, unknown> = {};
cyclic.url = cyclic;
check('handles a cyclic object without throwing (returns null)',
  getQueueableLabelUrl(cyclic) === null);

// ── getQueueableLabelUrl: purity (same input → same output) ──
check('getQueueableLabelUrl is pure (same input → same output)',
  getQueueableLabelUrl({ href: 'https://labels.example/q.pdf' })
    === getQueueableLabelUrl({ href: 'https://labels.example/q.pdf' }));

// ── getQueuePayloadEntries: array selection precedence ──
const queuedOrders = [{ id: 1 } as any, { id: 2 } as any];
check('returns the queuedOrders array when present',
  getQueuePayloadEntries({ queuedOrders }) === queuedOrders);
const entries = [{ id: 3 } as any];
check('falls back to the entries array',
  getQueuePayloadEntries({ entries }) === entries);
check('queuedOrders wins over entries when both present',
  getQueuePayloadEntries({ queuedOrders, entries }) === queuedOrders);

// ── getQueuePayloadEntries: empty/invalid → [] ──
check('returns [] for null',
  Array.isArray(getQueuePayloadEntries(null)) && getQueuePayloadEntries(null).length === 0);
check('returns [] for undefined',
  getQueuePayloadEntries(undefined).length === 0);
check('returns [] for a non-object',
  getQueuePayloadEntries('nope').length === 0);
check('returns [] when neither key is an array',
  getQueuePayloadEntries({ queuedOrders: 'x', entries: 7 }).length === 0);
check('returns [] for an empty object',
  getQueuePayloadEntries({}).length === 0);

// ── STATIC: the new module exports both functions and is type-checked ──
const moduleSrc = readFileSync(MODULE_PATH, 'utf8');
for (const fn of ['getQueueableLabelUrl', 'getQueuePayloadEntries']) {
  check(`module exports ${fn}`, new RegExp(`export function ${fn}\\b`).test(moduleSrc));
}
check('module is NOT @ts-nocheck (genuinely type-checked)',
  !/@ts-nocheck/.test(moduleSrc));

// ── STATIC: OrdersView imports both and no longer defines either local ──
const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');
check('OrdersView imports getQueueableLabelUrl + getQueuePayloadEntries from ./orders-queue-parsers',
  /import \{ getQueueableLabelUrl, getQueuePayloadEntries \} from '\.\/orders-queue-parsers'/.test(ordersView));
check('OrdersView no longer defines function getQueueableLabelUrl',
  !/function getQueueableLabelUrl\b/.test(ordersView));
check('OrdersView no longer defines function getQueuePayloadEntries',
  !/function getQueuePayloadEntries\b/.test(ordersView));
check('OrdersView still calls getQueueableLabelUrl( (call sites preserved)',
  /getQueueableLabelUrl\(/.test(ordersView));
check('OrdersView still calls getQueuePayloadEntries( (call sites preserved)',
  /getQueuePayloadEntries\(/.test(ordersView));

check('package.json wires test:ps-258-orders-queue-parsers',
  /test:ps-258-orders-queue-parsers/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-258 orders-queue-parsers guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-258 orders-queue-parsers guard');
