/**
 * PS-163 — carrier-account label-rename backfill ownership guard.
 *
 * The awaiting-order rate-snapshot nickname backfill SQL was moved out of the carrier-accounts PATCH
 * imported-handler into the credential-accounts service (single owner). This guard asserts:
 *   - the service owns backfillAwaitingSnapshotNickname,
 *   - BOTH of its UPDATE statements are gated `order_status = 'awaiting_shipment'` (the shipped/cancelled
 *     protection — this must NEVER touch shipped/cancelled orders),
 *   - the handler delegates (imports + calls it) and no longer runs the UPDATE inline.
 *
 * Offline / pure: readFileSync only.
 */
import { readFileSync } from 'node:fs';

const service = readFileSync('src/services/credential-accounts.ts', 'utf8');
const handler = readFileSync('src/lib/imported-handlers/carrier-accounts.ts', 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── (1) service owns the backfill ──
check('credential-accounts.ts exports backfillAwaitingSnapshotNickname',
  /export async function backfillAwaitingSnapshotNickname\(/.test(service));

// ── (2) BOTH UPDATEs are awaiting-only (shipped/cancelled protection) ──
const updateBlocks = service.match(/UPDATE order_overrides[\s\S]*?(?=`\) as unknown)/g) ?? [];
check('the owner has exactly 2 order_overrides UPDATE statements', updateBlocks.length === 2,
  `found ${updateBlocks.length}`);
check('EVERY backfill UPDATE is gated order_status = \'awaiting_shipment\' (never shipped/cancelled)',
  updateBlocks.length === 2 && updateBlocks.every((b) => /AND o\.order_status = 'awaiting_shipment'/.test(b)));
check('backfill targets the best_rate_json nickname fields only',
  /'\{providerAccountNickname\}'/.test(service) && /'\{carrierNickname\}'/.test(service));

// ── (3) handler delegates, no inline UPDATE ──
check('handler imports backfillAwaitingSnapshotNickname', /backfillAwaitingSnapshotNickname/.test(handler));
check('handler calls the service backfill (delegates)',
  /ordersUpdated = await backfillAwaitingSnapshotNickname\(sql, before\.label, patch\.label\)/.test(handler));
check('handler no longer runs the backfill UPDATE inline',
  !/UPDATE order_overrides/.test(handler));

if (failures > 0) {
  console.error(`\nFAIL PS-163 backfill-owner guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-163 backfill-owner guard (service owns awaiting-only backfill; handler delegates)');
