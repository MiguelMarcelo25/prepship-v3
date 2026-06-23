/**
 * PS-277 (slice 2) guard — the side panel reads the persisted SOT, not an independent number.
 *
 * Invariant B: the side-panel rate box must show the SAME value the BEST RATE column shows
 * (getBackendRowMoney(...).markedAmount off the persisted SOT), so panel == column. The ephemeral
 * panelPreviewRate is demoted to a transient fallback (only before the SOT row refetches) — and it's
 * SAFE because refreshPanelBestRate persists every live result to the SOT (persistAppliedRateForOrder),
 * so the SOT-backed display is always fresh.
 *
 *   npx tsx scripts/ps-277-panel-reads-sot-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const ov = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-166/PS-306/PS-258 (Wave 5): the order-detail side-panel rate box (the SOT /
// preview branch markup) was extracted VERBATIM from OrdersView into
// OrdersDetailSidePanel.tsx. The shell still owns refreshPanelBestRate + the SOT
// persistence; only the display branches moved. Re-anchor the markup checks there.
const panel = readFileSync('web/src/components/Views/OrdersDetailSidePanel.tsx', 'utf8');

const sotBranch = panel.indexOf(') : panelDisplayOrder.bestRate ? (');
const previewBranch = panel.indexOf(') : panelPreviewRate ? (');

check('panel rate box has the SOT branch (panelDisplayOrder.bestRate)', sotBranch >= 0);
check('panel rate box has the preview branch (panelPreviewRate)', previewBranch >= 0);
check('the panel reads the persisted SOT BEFORE the ephemeral preview (SOT-first parity with the column)',
  sotBranch >= 0 && previewBranch >= 0 && sotBranch < previewBranch);
check('the panel rate amount comes from the SAME backend money tuple the column uses (getBackendRowMoney markedAmount)',
  /getBackendRowMoney\(panelDisplayOrder\)\?\.markedAmount \?\? getBestRateBaseCost\(panelDisplayOrder\)/.test(panel));
check('refreshPanelBestRate persists every live result to the SOT (so SOT-first display is fresh)',
  /await persistAppliedRateForOrder\(order\.orderId, bestRateWithMetadata/.test(ov));

check('package.json wires test:ps-277-panel-reads-sot',
  /test:ps-277-panel-reads-sot/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-277 panel-reads-SOT guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-277 panel-reads-SOT guard');
