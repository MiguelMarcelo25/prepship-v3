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
 *   8. Selected-rate persistence (this slice, card DoD item 6): when the
 *      operator SELECTS a preview rate and saves, the chosen rate
 *      (carrier/service/amount + account nickname + selected ship-from origin)
 *      is persisted onto the created order in the canonical bestRate shape
 *      (order_overrides.bestRateJson via normalizeOrderBestRateDto), so Create
 *      Label / Print Queue reuse it without a silent re-rate. Backend owns the
 *      normalization; the modal only passes the selected row + origin verbatim.
 *
 *   6. Ship-From selector (earlier slice): the rate preview no longer hard-codes
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

// ── 7) FE: marketplace-owned providers EXCLUDED + account nickname displayed ──
{
  // 7a — the marketplace-exclusion + nickname helpers live in their own small
  // file (repo convention: new functions in new files). The modal imports them
  // rather than re-deriving the marketplace provider set inline.
  let helperSrc = '';
  try { helperSrc = readFileSync('web/src/components/new-order-rate-preview-rows.ts', 'utf8'); }
  catch { helperSrc = ''; }
  check('FE: new-order-rate-preview-rows helper file exists', helperSrc.length > 0);

  // The helper names the canonical marketplace-owned providers the manual
  // preview must drop (they need a real marketplace order id and cannot be
  // quoted/purchased from an unsaved manual order).
  check('FE(7a): helper excludes ebay_shipping + walmart_shipping marketplace providers',
    /ebay_shipping/.test(helperSrc) && /walmart_shipping/.test(helperSrc));

  // The helper exposes a predicate and a row-filter the modal delegates to.
  check('FE(7b): helper exposes a marketplace predicate + row filter',
    /export\s+function\s+isMarketplaceOwnedProvider\b/.test(helperSrc) &&
    /export\s+function\s+excludeMarketplaceOwnedRows\b/.test(helperSrc));

  // 7c — the modal applies the marketplace exclusion to the preview rows.
  const getRatesMatch2 = /async function handleGetRates\(\)[\s\S]*?\r?\n  }\r?\n\s*\r?\n  async function handleSubmit/.exec(modalSrc);
  const getRatesSrc2 = getRatesMatch2 ? getRatesMatch2[0] : '';
  check('FE(7c): rate preview applies excludeMarketplaceOwnedRows to the rows',
    /excludeMarketplaceOwnedRows\s*\(/.test(getRatesSrc2));

  // 7d — the RatePreviewRow carries an account nickname sourced from the
  // backend rate's carrierNickname (the Rate Browser nickname field).
  check('FE(7d): RatePreviewRow carries an accountNickname field',
    /interface RatePreviewRow\s*\{[\s\S]*?accountNickname[\s\S]*?\}/.test(modalSrc));
  check('FE(7e): preview maps accountNickname from the rate carrierNickname',
    /accountNickname:\s*[^\n]*carrierNickname/.test(modalSrc));

  // 7f — the row renders the nickname ABOVE the service name (a stacked block:
  // nickname line then serviceLabel line), gated on a present nickname.
  check('FE(7f): the preview row renders the account nickname above the service name',
    /r\.accountNickname\b/.test(modalSrc));
}

// ── 8) SELECT a preview rate → persist it onto the saved order ─────────────
// Card DoD item 6: when the operator SELECTS a preview rate and Saves, the
// chosen rate (carrier/service/amount/account nickname + the selected ship-from
// origin) is persisted onto the created order in the CANONICAL best-rate shape,
// so Create Label / Print Queue reuse it without a silent re-rate. The backend
// is the source of truth: it normalizes the selected rate through
// normalizeOrderBestRateDto (the same canonical owner the PATCH best-rate path
// uses) and writes it into order_overrides.bestRateJson.
{
  // 8a — a small backend helper owns building the canonical bestRate DTO from a
  // manual-order selected preview rate (repo convention: new function, new file).
  let selectedRateHelperSrc = '';
  try { selectedRateHelperSrc = readFileSync('src/routes/orders/manual-selected-rate.ts', 'utf8'); }
  catch { selectedRateHelperSrc = ''; }
  check('BE: orders/manual-selected-rate helper file exists', selectedRateHelperSrc.length > 0);

  // The helper delegates to the canonical normalizer (it does not re-derive the
  // persisted rate shape inline) and is exported for the route to consume.
  check('BE(8a): helper builds the canonical bestRate via normalizeOrderBestRateDto',
    /normalizeOrderBestRateDto\s*\(/.test(selectedRateHelperSrc));
  check('BE(8b): helper exports buildManualSelectedBestRate',
    /export\s+function\s+buildManualSelectedBestRate\b/.test(selectedRateHelperSrc));

  // 8c — manualOrderBody accepts an OPTIONAL selectedRate (carrier/service/amount
  // + account nickname + ship-from origin). Optional so save-without-selection
  // still works (line items remain optional too).
  const selectedRateSchemaMatch = /selectedRate:\s*z\.object\([\s\S]*?\)\.optional\(\)/.exec(ordersSrc);
  check('BE(8c): manualOrderBody declares an optional selectedRate object',
    selectedRateSchemaMatch != null);

  // 8d — the POST /manual route persists the selected rate into
  // order_overrides.bestRateJson (the column Create Label / Print Queue read),
  // by delegating to the helper. Bounded to the /manual route body.
  check('BE(8d): the /manual route delegates to buildManualSelectedBestRate',
    /buildManualSelectedBestRate\s*\(/.test(manualRouteSrc));
  check('BE(8e): the persisted overrides carry the selected bestRateJson',
    /bestRateJson:/.test(manualRouteSrc));

  // 8f — FE: the modal tracks which preview rate the operator SELECTED. A
  // clickable preview row sets a selected-rate state (index or row).
  check('FE(8a): the modal tracks a selected preview rate (selectedRate state)',
    /selectedRateIndex|selectedRate\b|setSelectedRate/.test(modalSrc));

  // 8g — the save payload threads the selected rate + the selected ship-from
  // origin so the backend can persist them. The NewOrderPayload type carries a
  // selectedRate field, and handleSubmit populates it from the chosen row.
  const handleSubmitMatch = /async function handleSubmit\([\s\S]*?\n  }\r?\n/.exec(modalSrc);
  const handleSubmitSrc = handleSubmitMatch ? handleSubmitMatch[0] : '';
  check('FE: handleSubmit body located', handleSubmitSrc.length > 0);
  check('FE(8b): NewOrderPayload declares a selectedRate field',
    /selectedRate\?:\s*\{[\s\S]*?\}\s*\|\s*null/.test(modalSrc) || /selectedRate:\s*[A-Za-z]/.test(modalSrc));
  check('FE(8c): handleSubmit threads the selected rate into the save payload',
    /selectedRate:/.test(handleSubmitSrc));
  check('FE(8d): handleSubmit threads the selected ship-from origin',
    /shipFrom(?:Origin)?\b/.test(handleSubmitSrc));

  // 8h — the preview rows are clickable to select (an onClick that sets the
  // selected rate). Bounded to the rates.map render block.
  const ratesRenderMatch = /\{rates\.map\(\(r, idx\)[\s\S]*?\}\)\}/.exec(modalSrc);
  const ratesRenderSrc = ratesRenderMatch ? ratesRenderMatch[0] : '';
  check('FE: rates.map render block located', ratesRenderSrc.length > 0);
  check('FE(8e): preview rows are clickable to select a rate',
    /onClick=\{[^}]*setSelectedRate|onClick=\{[^}]*selectedRate/.test(ratesRenderSrc));
}

if (failures > 0) {
  console.error(`\nFAIL PS-291 manual-order real + optional-items guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-291 manual-order real + optional-items guard');
