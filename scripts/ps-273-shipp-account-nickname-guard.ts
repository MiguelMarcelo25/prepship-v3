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
} from '../src/services/shipping-workflow/shipp-account-nickname-backfill';

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

if (failures > 0) {
  console.error(`\nFAIL PS-273 Shipp account nickname guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-273 Shipp account nickname guard');
