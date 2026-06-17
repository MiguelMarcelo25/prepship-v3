/**
 * PS-273 guard — a Shipp-brokered label must NEVER display a fabricated direct
 * carrier account. Identity FIRST, carrier family second.
 *
 * THE BUG: a Shipp label stored only a synthetic provider id (10_000_000 +
 * carrier_accounts.id) and no shipments.provider_account_nickname. The FE
 * resolveV2CarrierAccount then fell back to carrier-code 'ups' and returned the
 * first shared UPS account (GG6381 on order #1587) — a direct account the label
 * was never bought on.
 *
 * THE FIX (pinned here):
 *   1. resolveV2CarrierAccount returns null for carrier-code-only input (no
 *      first-shared-account fabrication); it ONLY resolves an exact provider id.
 *   2. resolveDisplayShipAccount prefers "Shipp" (brokered shipp_* service code)
 *      and live/persisted truth over the static-registry guess and 'External'.
 *   3. A Shipp shipment renders "Shipp", never GG6381.
 *   4. persistCreatedLabel WRITES provider_account_nickname (forward fix) and
 *      labels-direct stamps "Shipp" for Shipp-brokered labels.
 *   5. The dry-run backfill planner derives "Shipp" only for brokered rows
 *      missing a nickname.
 *
 *   npx tsx scripts/ps-273-shipp-account-nickname-guard.ts
 */
import { readFileSync } from 'node:fs';
import { resolveV2CarrierAccount } from '../web/src/components/Views/orders-row-display';
import {
  resolveDisplayShipAccount,
  isShippBrokeredServiceCode,
  SHIPP_BROKERED_ACCOUNT_LABEL,
} from '../web/src/components/Views/order-shipping-display';
import {
  planShippNicknameBackfillRow,
  isShippBrokeredServiceCode as isShippBrokeredServiceCodeBackend,
  SHIPP_BROKERED_ACCOUNT_LABEL as SHIPP_BROKERED_ACCOUNT_LABEL_BACKEND,
} from '../src/services/shipping-workflow/shipp-account-nickname-backfill';
// PS-273: the synthetic direct-carrier provider-id offset. The backend owner (src/routes/orders.ts)
// imports the SAME-valued constant from src/services/labels-direct to short-circuit
// resolveV2CarrierAccountRef. labels-direct eagerly opens a DB pool at import, so this OFFLINE guard
// pulls the identical value from the pure connector compatibility matrix instead (no DB/network),
// and statically asserts orders.ts wires the labels-direct copy below.
import { DIRECT_CARRIER_PROVIDER_ID_OFFSET } from '../src/connectors/compatibility-matrix';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── 1. resolveV2CarrierAccount: NO carrier-code fabrication ──────────────────
// The synthetic Shipp provider id (10_000_000 + 25) has no registry entry; the
// old fallback matched carrierCode='ups' and returned GG6381. Now: null.
check(
  'carrier-code-only "ups" returns null (no first-shared GG6381 fabrication)',
  resolveV2CarrierAccount(null, 'ups', null) === null,
);
check(
  'synthetic Shipp provider id (10000025) returns null (not in registry)',
  resolveV2CarrierAccount(10000025, 'ups', 10) === null,
);
check(
  'carrier-code "ups" with a client id still returns null (no shared guess)',
  resolveV2CarrierAccount(null, 'ups', 10) === null,
);
// Identity-first still works: an EXACT provider id resolves its real account.
const exact = resolveV2CarrierAccount(565326, null, null);
check('exact provider id 565326 still resolves GG6381', exact?.nickname === 'GG6381', String(exact?.nickname));

// ── 1b. BACKEND owner (src/routes/orders.ts) — the canonical fix lives here ───
// resolveV2CarrierAccountRef + the DTO account resolution own the fact the FE only displays.
// orders.ts eagerly opens a DB pool at import (db/client), so we cannot CALL it in this offline
// guard; we (a) statically assert the source carries the fix, and (b) reproduce the pure decision
// against the SAME imported constants/helpers so the numeric + precedence contract can't drift.
const ordersSrc = readFileSync('src/routes/orders.ts', 'utf8');

// (a) resolveV2CarrierAccountRef short-circuits to null for any synthetic direct-carrier id, so a
//     Shipp-brokered provider id (10_000_000 + carrier_accounts.id) can never reach the 1Z /
//     carrier-family fabrication that returned GG6381 on order #1587.
check(
  'orders.ts: resolveV2CarrierAccountRef is exported (so the contract is testable)',
  /export function resolveV2CarrierAccountRef\(/.test(ordersSrc),
);
check(
  'orders.ts: synthetic direct id short-circuits to null before the carrier-family/1Z fabrication',
  /providerAccountId >= DIRECT_CARRIER_PROVIDER_ID_OFFSET\) return null;/.test(ordersSrc),
);
check(
  'orders.ts: imports the offset from the canonical labels-direct owner',
  /import \{ DIRECT_CARRIER_PROVIDER_ID_OFFSET \} from '\.\.\/services\/labels-direct';/.test(ordersSrc),
);
check(
  'orders.ts: imports the brokered-Shipp identity helpers from the shared service',
  /isShippBrokeredServiceCode,[\s\S]{0,80}SHIPP_BROKERED_ACCOUNT_LABEL,[\s\S]{0,120}shipp-account-nickname-backfill';/.test(ordersSrc),
);
// (b) DTO account resolution: the brokered "Shipp" label is substituted ONLY as a fallback that
//     precedes the static-registry fabrication, and NEVER ahead of persisted nicknames.
check(
  'orders.ts: providerAccountNickname prefers persisted nickname, then brokered "Shipp", then registry',
  /ship\.provider_account_nickname \?\?\s*\(isShippBrokeredShipment \? SHIPP_BROKERED_ACCOUNT_LABEL : null\) \?\?\s*resolvedCarrierAccount\?\.nickname/.test(ordersSrc),
);
check(
  'orders.ts: accountPick inserts the brokered "Shipp" slot BEFORE the V2_CARRIER_ACCOUNT_REFS guess',
  (() => {
    // CRLF-safe: match the brokered slot by its UNIQUE source tag (only in the accountPick brokered
    // slot) instead of a newline-bearing literal that breaks on \r\n line endings.
    const brokeredIdx = ordersSrc.indexOf("'shipp_brokered_account_label'");
    const registryIdx = ordersSrc.indexOf("value: resolvedCanonicalCarrierAccount?.nickname,");
    return brokeredIdx > 0 && registryIdx > 0 && brokeredIdx < registryIdx;
  })(),
);
check(
  'orders.ts: accountPick slot #2 stays the RAW persisted nickname (Shipp must not pre-empt persisted best-rate nicknames)',
  /value: ship\?\.provider_account_nickname \?\? null,/.test(ordersSrc),
);

// (b') Pure re-derivation of resolveV2CarrierAccountRef's offset gate, tied to the imported constant.
function backendDirectIdResolvesNull(providerAccountId: number): boolean {
  // Mirrors the orders.ts gate: an exact registry hit would win first (none exist for direct ids),
  // then any id at/above the offset returns null — no carrier-family / 1Z fabrication.
  return providerAccountId >= DIRECT_CARRIER_PROVIDER_ID_OFFSET;
}
check(
  'backend offset gate: resolveV2CarrierAccountRef(10000025,"ups","1Z…",10) === null',
  backendDirectIdResolvesNull(10_000_000 + 25) === true,
);
check(
  'backend offset gate: a real ShipStation id (565326) is NOT short-circuited (exact match still wins)',
  backendDirectIdResolvesNull(565326) === false,
);

// (b'') Pure re-derivation of the DTO account resolution for the #1587 row: a brokered Shipp DTO
//       row with NULL provider_account_nickname + carrier_code 'ups' + 1Z tracking resolves
//       account = "Shipp", NEVER GG6381. Uses the SAME backend helpers orders.ts imports.
function resolveBrokeredDtoAccount(row: {
  providerAccountNickname: string | null;
  serviceCode: string | null;
  source: string | null;
  registryGuess: string | null; // what V2_CARRIER_ACCOUNT_REFS WOULD fabricate (e.g. 'GG6381')
}): string | null {
  const brokered =
    isShippBrokeredServiceCodeBackend(row.serviceCode) ||
    (typeof row.source === 'string' && row.source.trim().toLowerCase() === 'shipp');
  return (
    row.providerAccountNickname ??
    (brokered ? SHIPP_BROKERED_ACCOUNT_LABEL_BACKEND : null) ??
    row.registryGuess ??
    null
  );
}
check(
  'backend DTO: brokered Shipp row (null nickname, ups, 1Z) resolves "Shipp", never GG6381',
  resolveBrokeredDtoAccount({
    providerAccountNickname: null,
    serviceCode: 'shipp_ups_ground',
    source: 'shipp',
    registryGuess: 'GG6381',
  }) === SHIPP_BROKERED_ACCOUNT_LABEL_BACKEND,
);
check(
  'backend DTO: a genuinely-persisted provider_account_nickname STILL wins over "Shipp"',
  resolveBrokeredDtoAccount({
    providerAccountNickname: 'ROCEL C81F70',
    serviceCode: 'shipp_ups_ground',
    source: 'shipp',
    registryGuess: 'GG6381',
  }) === 'ROCEL C81F70',
);
check(
  'backend DTO: a NON-brokered row never substitutes "Shipp" (falls to the registry guess)',
  resolveBrokeredDtoAccount({
    providerAccountNickname: null,
    serviceCode: 'ups_ground',
    source: 'prepship_v2',
    registryGuess: 'GG6381',
  }) === 'GG6381',
);

// ── 2 & 3. resolveDisplayShipAccount: "Shipp" over the fabricated GG6381 ──────
const baseAcct = {
  isTest: false,
  awaitingBestRateNickname: null,
  canonicalNickname: null,
  selectedNickname: null,
  v2AccountNickname: null,
  hasSelectedRate: false,
  labelAccountLabel: null,
  bestRateNickname: null,
  carrierCodeFallback: null,
  brokeredServiceCode: null,
};

check('isShippBrokeredServiceCode detects shipp_ups_ground', isShippBrokeredServiceCode('shipp_ups_ground'));
check('isShippBrokeredServiceCode rejects ups_ground', !isShippBrokeredServiceCode('ups_ground'));

// Un-backfilled Shipp row: only a stale static guess (GG6381) + brokered service
// code. Must render "Shipp", NEVER GG6381.
check(
  'un-backfilled Shipp shipment renders "Shipp", not GG6381',
  resolveDisplayShipAccount({
    ...baseAcct,
    v2AccountNickname: 'GG6381',
    brokeredServiceCode: 'shipp_ups_ground',
    hasSelectedRate: true,
  }) === SHIPP_BROKERED_ACCOUNT_LABEL,
);
// Backfilled Shipp row: persisted nickname wins outright.
check(
  'backfilled Shipp shipment renders persisted "Shipp" via selectedNickname',
  resolveDisplayShipAccount({ ...baseAcct, selectedNickname: 'Shipp', v2AccountNickname: 'GG6381', brokeredServiceCode: 'shipp_ups_ground' }) === 'Shipp',
);
// Live label-account truth wins over the static guess and 'External'.
check(
  'live label account beats the static-registry guess and External',
  resolveDisplayShipAccount({ ...baseAcct, labelAccountLabel: 'Shipp', v2AccountNickname: 'GG6381', hasSelectedRate: true }) === 'Shipp',
);
// A NON-Shipp row with a legitimate exact-id v2 match still shows it (no regression).
check(
  'non-Shipp exact v2 account still displays (no over-correction)',
  resolveDisplayShipAccount({ ...baseAcct, v2AccountNickname: 'ORION', brokeredServiceCode: 'ups_ground' }) === 'ORION',
);

// ── 4. persistCreatedLabel WRITES the nickname (forward fix, static check) ────
const labelsSrc = readFileSync('src/services/labels.ts', 'utf8');
check(
  'persistCreatedLabel writes providerAccountNickname to the shipments row',
  /providerAccountNickname:\s*created\.providerAccountNickname/.test(labelsSrc),
);
check(
  'selected_rate_json carries providerAccountNickname',
  /selectedRateJson:\s*\{[\s\S]{0,400}providerAccountNickname:\s*created\.providerAccountNickname/.test(labelsSrc),
);
check(
  'ShipStation path resolves the nickname via resolveCarrierNickname',
  /created\.providerAccountNickname\s*=\s*[\s\S]{0,80}resolveCarrierNickname/.test(labelsSrc),
);
const directSrc = readFileSync('src/services/labels-direct.ts', 'utf8');
check(
  'direct path stamps "Shipp" for Shipp-brokered labels',
  /provider === 'shipp'[\s\S]{0,40}'Shipp'/.test(directSrc) &&
    /providerAccountNickname,/.test(directSrc),
);
const typeSrc = readFileSync('src/lib/shipstation/labels.ts', 'utf8');
check(
  'CreatedExternalLabel type carries providerAccountNickname',
  /providerAccountNickname\??:\s*string \| null/.test(typeSrc),
);

// ── 5. backfill planner: brokered + missing-nickname only ────────────────────
check(
  'backfill plans "Shipp" for a brokered row missing a nickname',
  (() => {
    const p = planShippNicknameBackfillRow({ shipmentId: 1, orderId: 1587, orderNumber: '1587', serviceCode: 'shipp_ups_ground', source: 'shipp', providerAccountNickname: null });
    return p.affected && p.nickname === 'Shipp';
  })(),
);
check(
  'backfill skips a row that already has a nickname (idempotent)',
  !planShippNicknameBackfillRow({ shipmentId: 2, orderId: 2, orderNumber: '2', serviceCode: 'shipp_ups_ground', source: 'shipp', providerAccountNickname: 'Shipp' }).affected,
);
check(
  'backfill skips a non-Shipp row',
  !planShippNicknameBackfillRow({ shipmentId: 3, orderId: 3, orderNumber: '3', serviceCode: 'ups_ground', source: 'prepship_v2', providerAccountNickname: null }).affected,
);

// ── 6. the backfill script is dry-run by default (NOT auto-apply) ────────────
const backfillSrc = readFileSync('scripts/ps-273-backfill-shipp-account-nickname.ts', 'utf8');
check(
  'backfill apply is double-gated (--apply AND --confirm-production)',
  /const willApply = apply && confirmProduction/.test(backfillSrc),
);
check(
  'backfill does not auto-apply (exits early when --apply is absent)',
  /if \(!apply\) \{\s*process\.exit\(0\)/.test(backfillSrc),
);

// ── 7. FE orders-table readers gate the RAW carrierNickname behind the brokered ─
//      check (the "980006 / GG6381" vector). These readers (used by the orders
//      table + OrdersView) don't all route through resolveDisplayShipAccount, so
//      each must short-circuit a Shipp-brokered row to "Shipp" BEFORE falling to
//      the raw rate carrierNickname. Non-Shipp rows keep their exact precedence.
//      Pure static read; CRLF-safe via indexOf ordering.
const rowDisplaySrc = readFileSync('web/src/components/Views/orders-row-display.tsx', 'utf8');
function brokeredGuardPrecedesLeak(fnName: string, leakToken: string): boolean {
  const start = rowDisplaySrc.indexOf(`export function ${fnName}`);
  if (start < 0) return false;
  const next = rowDisplaySrc.indexOf('export function', start + 1);
  const body = rowDisplaySrc.slice(start, next < 0 ? undefined : next);
  const guardIdx = body.indexOf('isShippBrokeredServiceCode');
  const leakIdx = body.indexOf(leakToken);
  return guardIdx > 0 && leakIdx > 0 && guardIdx < leakIdx;
}
check(
  'orders-row-display imports the canonical brokered helpers',
  /isShippBrokeredServiceCode/.test(rowDisplaySrc) && /SHIPP_BROKERED_ACCOUNT_LABEL/.test(rowDisplaySrc),
);
check(
  'getSelectedRateCarrierNickname: brokered "Shipp" precedes the raw selectedRate.carrierNickname',
  brokeredGuardPrecedesLeak('getSelectedRateCarrierNickname', 'selectedRate?.carrierNickname'),
);
check(
  'getAwaitingDisplayAccountNickname: brokered "Shipp" precedes the raw selectedRate.carrierNickname',
  brokeredGuardPrecedesLeak('getAwaitingDisplayAccountNickname', 'selectedRate?.carrierNickname'),
);
check(
  'getBestRateCarrierNickname: brokered "Shipp" precedes the raw bestRate carrierNickname',
  brokeredGuardPrecedesLeak('getBestRateCarrierNickname', '.carrierNickname'),
);

// ── 7b. OrderDetailDrawer.tsx is a LIVE lazy-loaded drawer (OrdersView:110/9471),
//        not dead code. Its accountLabel cascade must resolve the brokered "Shipp"
//        BEFORE the raw selectedRate.carrierNickname (the 980006/GG6381 vector).
{
  const drawerSrc = readFileSync('web/src/components/OrderDetailDrawer.tsx', 'utf8');
  const start = drawerSrc.indexOf('const accountLabel = textValue(');
  const end = start >= 0 ? drawerSrc.indexOf(');', start) : -1;
  const body = start >= 0 && end > start ? drawerSrc.slice(start, end) : '';
  const guardIdx = body.indexOf('isShippBrokeredServiceCode');
  const leakIdx = body.indexOf('selectedRate.carrierNickname');
  check('OrderDetailDrawer imports the brokered helpers',
    /isShippBrokeredServiceCode/.test(drawerSrc) && /SHIPP_BROKERED_ACCOUNT_LABEL/.test(drawerSrc));
  check('OrderDetailDrawer accountLabel: brokered "Shipp" precedes selectedRate.carrierNickname',
    guardIdx > 0 && leakIdx > 0 && guardIdx < leakIdx);
}

if (failures > 0) {
  console.error(`\nFAIL PS-273 Shipp account nickname guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-273 Shipp account nickname guard');
