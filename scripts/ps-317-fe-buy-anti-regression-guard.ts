import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// PS-317 — FE-buy anti-regression guard.
//
// Thesis: the backend owns ALL business truth. The frontend only renders DTOs
// and SENDS operator intent. The A1→A4 money-path cutover DELETED the FE
// direct-carrier buy (createDirectCarrierLabelThenQueue); backend createLabelV2
// now owns the direct-carrier purchase (selected-rate-proof gate, PS-204 account
// binding, inventory deduction, marketplace confirmation).
//
// This guard PINS the genuinely-dead direct-carrier orchestration so it can never
// return. It is deliberately scoped per the adversarial-audit ruling:
//
//   • apiClient.createLabel (OrdersView single + batch Create+Print) is NOT an
//     FE-owned buy. It is a thin api.post('/labels', payload) to the backend
//     (createLabelV2). The FE only ASSEMBLES the payload and sends intent.
//   • The createLabel-then-addToQueue batch sequence is the LIVE, INTENDED flow.
//     addToQueue only enqueues an ALREADY-backend-bought label; it does not rank,
//     select, or buy a rate. This guard MUST NOT assert that sequence is gone —
//     doing so would falsely go RED on the current (correct) tree.
//
// We assert only the dead pattern: the deleted createDirectCarrierLabelThenQueue
// and the FE re-owning a direct-carrier purchase orchestration.

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── helper: recursively scan web/src for a literal token ─────────────────────
const WEB_SRC = join('web', 'src');
const SCANNABLE = /\.(ts|tsx|js|jsx)$/;

function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkSrc(full));
    } else if (SCANNABLE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const srcFiles = walkSrc(WEB_SRC);

function countOccurrencesUnderSrc(token: string): { count: number; files: string[] } {
  let count = 0;
  const files: string[] = [];
  for (const file of srcFiles) {
    const text = readFileSync(file, 'utf8');
    let idx = text.indexOf(token);
    if (idx !== -1) files.push(file);
    while (idx !== -1) {
      count += 1;
      idx = text.indexOf(token, idx + token.length);
    }
  }
  return { count, files };
}

// ── (a) the deleted FE direct-carrier buy never returns ──────────────────────
// createDirectCarrierLabelThenQueue must have ZERO occurrences anywhere under
// web/src — not in a call site, a definition, an import, or a string.
const directBuy = countOccurrencesUnderSrc('createDirectCarrierLabelThenQueue');
check(
  'createDirectCarrierLabelThenQueue has ZERO occurrences under web/src (deleted FE direct-carrier buy stays dead)',
  directBuy.count === 0,
);
if (directBuy.count > 0) {
  console.error(`     found in: ${directBuy.files.join(', ')}`);
}

// ── (b) the 'direct-create' route is a no-op / backend-routing branch ─────────
// In OrdersView the 'direct-create' route must NOT trigger an FE label purchase.
// It now routes the order to the SAME backend create/recover job as everything
// else (it pushes to backendJobOrders), carrying the explicit intent comment
// "the frontend no longer buys ANY label".
const ordersViewPath = join('web', 'src', 'components', 'Views', 'OrdersView.tsx');
const ordersView = readFileSync(ordersViewPath, 'utf8');

check(
  "OrdersView no longer has the obsolete 'direct-create' frontend route token",
  !ordersView.includes("'direct-create'") && !ordersView.includes('"direct-create"'),
);
check(
  "OrdersView routes orders to the backend job (backendJobOrders) — no FE purchase",
  ordersView.includes('backendJobOrders'),
);
check(
  "OrdersView keeps the backend-owned queue intent comment",
  /OrdersView no longer computes a direct-vs-backend route/.test(ordersView) &&
    /Every selected order is sent as backend intent/.test(ordersView) &&
    /Print Queue owner performs create\/recover\/queue routing/.test(ordersView),
);
// The genuinely-dead pattern a regression would reintroduce: an FE direct/synthetic
// -carrier label purchase orchestration OUTSIDE apiClient.createLabel. Pin that the
// 'direct-create' branch does NOT call a direct-carrier buy helper of that family.
check(
  "the 'direct-create' branch does NOT reintroduce an FE direct-carrier buy helper",
  !/createDirectCarrierLabel(ThenQueue|ForOrder)?\s*\(/.test(ordersView),
);

// ── (c) apiClient.createLabel is backend-owned (intent-to-backend, not a buy) ─
// Prove the FE "buy" call is a thin POST to the backend /labels route
// (-> createLabelV2), not a local purchase orchestration.
const apiClientPath = join('web', 'src', 'lib', 'v2-apiClient.ts');
const apiClient = readFileSync(apiClientPath, 'utf8');

check(
  'v2-apiClient defines createLabel',
  /createLabel\s*\(payload[^)]*\)\s*:/.test(apiClient) || /createLabel\s*\(/.test(apiClient),
);
check(
  "createLabel issues a backend POST to '/labels' (intent-to-backend, the backend owns the buy)",
  /api\.post<[^>]*>\(\s*['"]\/labels['"]/.test(apiClient) ||
    /api\.post\(\s*['"]\/labels['"]/.test(apiClient),
);

// ── (d) harden against a RENAMED re-introduction of the FE buy ───────────────
// (a)-(c) pin the exact dead name + the direct-create routing + that createLabel is
// a backend POST. A regression could instead re-own a direct-carrier PURCHASE under
// a DIFFERENT helper name. The FE legitimately SENDS intent via apiClient.createLabel
// and never "buys"/"purchases" a direct carrier itself, so a buy/purchase-Direct*
// helper anywhere under web/src is a re-introduction. This only matches buy/purchase
// VERBS — payload builders / proof selectors / display readers are unaffected.
const FORBIDDEN_FE_DIRECT_BUY =
  /\b(?:buyDirect\w*|purchaseDirect\w*|directCarrier(?:Buy|Purchase)\w*)\s*\(/;
const renamedHit = srcFiles.find((file) => FORBIDDEN_FE_DIRECT_BUY.test(readFileSync(file, 'utf8')));
check(
  'no renamed FE direct-carrier buy/purchase helper under web/src (hardening vs a re-owned purchase)',
  renamedHit === undefined,
);
if (renamedHit) {
  console.error(`     forbidden FE direct-carrier buy/purchase pattern in: ${renamedHit}`);
}

if (failures > 0) {
  console.error(`\nFAIL PS-317 FE-buy anti-regression guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-317 FE-buy anti-regression guard');
