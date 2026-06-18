/**
 * PS-291 (slice 1) — manual orders are REAL + line items OPTIONAL guard.
 *
 * Static reads (no DB, no network, no postage) over the canonical owners that
 * decide whether a saved manual order is a real operational order and whether
 * line items are mandatory. Repo convention (see ps-275/ps-258 guards):
 * cwd-relative paths, run from the repo root via `npx tsx` (avoids ESM
 * `__dirname is not defined`).
 *
 * Backend — src/routes/orders.ts, the POST /manual route + its helpers:
 *   1. The Manual Orders client is REAL: ensureManualOrdersClient writes
 *      isTest:false (NOT isTest:true) on both the update and the insert paths.
 *      clients.isTest is the backend SOT the row/detail DTOs derive `isTest`
 *      from, so this is what makes saved manual orders enter the real
 *      Awaiting/billing/rate flows.
 *   2. The order is NOT flagged test: the persisted `raw` blob does not set
 *      test:true.
 *   3. Line items are OPTIONAL: there is no hard-400 "at least one line item"
 *      branch, and the zod `items` schema no longer requires .min(1).
 *   4. Auth + validation preserved: the route still calls
 *      requireInternalPermission AND zValidator('json', manualOrderBody).
 *
 * Frontend — web/src/components/NewOrderModal.tsx:
 *   5. No >=1-line-item blocking validation remains (Save works with 0 items).
 *   6. Ship-From selector (this slice): the rate preview no longer hard-codes
 *      `fromPostalCode: defaultFromZip`. It reads the operator-selected origin
 *      (saved location OR a custom expandable origin) and threads the full
 *      origin (postal/state/country/street) into the /rates preview payload so
 *      the preview reflects the real ship-from. The backend rate quoter remains
 *      the origin source-of-truth (readShipFrom); the modal only passes the
 *      selected origin verbatim via fromPostalCode + a shipFrom object.
 *
 *   npx tsx scripts/ps-291-manual-order-real-optional-items-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const ordersSrc = readFileSync('src/routes/orders.ts', 'utf8');
const modalSrc = readFileSync('web/src/components/NewOrderModal.tsx', 'utf8');

// Isolate the ensureManualOrdersClient helper body so the isTest assertions
// pin the manual-orders client specifically (not some other client write).
const ensureFnMatch = /async function ensureManualOrdersClient\(\)[\s\S]*?\n}/.exec(ordersSrc);
const ensureFnSrc = ensureFnMatch ? ensureFnMatch[0] : '';

// Isolate the POST /manual route body (from its registration to the route's
// final returned 201). Bounds the "no hard-400 / auth+zod present" assertions.
const manualRouteStart = ordersSrc.indexOf("app.post('/manual'");
const manualRouteSrc = manualRouteStart >= 0
  ? ordersSrc.slice(manualRouteStart, ordersSrc.indexOf('}, 201);', manualRouteStart))
  : '';

// ── 1) Manual Orders client is REAL (isTest:false on BOTH paths) ───────────
{
  check('BE: ensureManualOrdersClient helper located', ensureFnSrc.length > 0);
  // The update path sets isTest:false.
  check('BE(1a): existing Manual Orders client is updated to isTest:false',
    /\.set\(\{[^}]*isTest:\s*false[^}]*\}\)/.test(ensureFnSrc));
  // The insert path uses isTest:false.
  check('BE(1b): newly-created Manual Orders client is inserted with isTest:false',
    /isTest:\s*false/.test(ensureFnSrc));
  // Belt-and-suspenders: the helper must NOT mark the manual client as a test
  // client on any path.
  check('BE(1c): the Manual Orders client helper never sets isTest:true',
    !/isTest:\s*true/.test(ensureFnSrc));
}

// ── 2) Persisted order raw blob is NOT flagged test ────────────────────────
{
  check('BE: POST /manual route body located', manualRouteSrc.length > 0);
  // The raw object literal must not carry a `test: true` field.
  check('BE(2): the manual order raw blob does not set test:true',
    !/\btest:\s*true\b/.test(manualRouteSrc));
}

// ── 3) Line items are OPTIONAL ─────────────────────────────────────────────
{
  // No hard-400 rejection on zero active items.
  check('BE(3a): no "at least one line item is required" 400 in the /manual route',
    !/at least one line item is required/i.test(manualRouteSrc));
  check('BE(3b): no activeItems.length === 0 hard-reject branch remains',
    !/activeItems\.length\s*===\s*0/.test(manualRouteSrc));
  // The zod items schema must not require a minimum of one entry.
  const itemsSchemaMatch = /items:\s*z\.array\([\s\S]*?\)\)\s*(\.[a-zA-Z]+\([^)]*\))*\s*,/.exec(ordersSrc);
  const itemsSchemaSrc = itemsSchemaMatch ? itemsSchemaMatch[0] : '';
  check('BE: manualOrderBody items schema located', itemsSchemaSrc.length > 0);
  check('BE(3c): the zod items schema no longer requires .min(1)',
    itemsSchemaSrc.length > 0 && !/\)\)\s*\.min\(1\)/.test(itemsSchemaSrc) && !/\.min\(1\)/.test(itemsSchemaSrc));
}

// ── 4) Auth + zod validation preserved on the route ────────────────────────
{
  check('BE(4a): POST /manual still calls requireInternalPermission',
    /app\.post\('\/manual',\s*requireInternalPermission\(/.test(ordersSrc));
  check('BE(4b): POST /manual still validates with zod manualOrderBody',
    /zValidator\('json',\s*manualOrderBody\)/.test(ordersSrc));
}

// ── 5) FE: no >=1-line-item blocking validation remains ────────────────────
{
  // The old gate pushed an "At least one line item" error and aborted Save.
  check('FE(5a): no "At least one line item" validation error string remains',
    !/At least one line item/i.test(modalSrc));
  // And no items-emptiness guard feeds the blocking errors[] / setError abort.
  check('FE(5b): no items.every(... no sku/name ...) blocking check remains',
    !/items\.every\(\([^)]*\)\s*=>\s*![^)]*sku[\s\S]{0,40}\)\)\s*errors\.push/.test(modalSrc));
}

// ── 6) FE: Ship-From selector threads the selected origin into rate preview ──
{
  // Isolate the handleGetRates body so the origin assertions pin the rate
  // preview specifically (not the save payload).
  // CRLF-tolerant: NewOrderModal.tsx uses \r\n line endings. Bound the body at
  // the next top-level `async function handleSubmit` declaration.
  const getRatesMatch = /async function handleGetRates\(\)[\s\S]*?\r?\n  }\r?\n\s*\r?\n  async function handleSubmit/.exec(modalSrc);
  const getRatesSrc = getRatesMatch ? getRatesMatch[0] : '';
  check('FE: handleGetRates body located', getRatesSrc.length > 0);

  // The preview must NOT hard-code fromPostalCode: defaultFromZip — that
  // ignored the operator's chosen ship-from. defaultFromZip may still be a
  // fallback, but the literal `fromPostalCode: defaultFromZip` assignment is
  // the symptom this slice removes.
  check('FE(6a): rate preview no longer hard-codes fromPostalCode: defaultFromZip',
    getRatesSrc.length > 0 && !/fromPostalCode:\s*defaultFromZip\b/.test(getRatesSrc));

  // The preview reads a resolved selected-origin object (the ship-from the
  // operator picked or typed) for the fromPostalCode.
  check('FE(6b): rate preview sources fromPostalCode from the selected origin',
    /fromPostalCode:\s*(selectedOrigin|origin|shipFromOrigin)\b/.test(getRatesSrc));

  // The full origin is threaded so the backend quoter sees street/state/country,
  // not just a ZIP — passed as a shipFrom object the canonical readShipFrom reads.
  check('FE(6c): rate preview threads the full origin via a shipFrom object',
    /shipFrom:\s*\{/.test(getRatesSrc) || /shipFrom:\s*(selectedOrigin|origin|shipFromOrigin)\b/.test(getRatesSrc));

  // There must be a Ship-From origin selector state/UI in the modal: a saved
  // locations origin selection PLUS a custom expandable origin.
  check('FE(6d): a Ship-From origin selector exists (saved + custom origin state)',
    /shipFromOrigin|originLocationId|customOrigin|useCustomOrigin/.test(modalSrc));
}

if (failures > 0) {
  console.error(`\nFAIL PS-291 manual-order real + optional-items guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-291 manual-order real + optional-items guard');
