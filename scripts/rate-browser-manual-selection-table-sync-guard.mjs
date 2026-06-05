/**
 * Guard: selecting a rate row from Browse Rates must update the Orders table
 * display source immediately, not only the side-panel form.
 *
 * Root cause locked here: table cells read getOrderWithAutoBestRate(), whose
 * in-memory autoBestRateEntries can outrank the saved order row. Manual rate
 * selection must seed that same entry with request metadata so the row changes
 * from the old auto-best account (for example Greg) to the selected account
 * (for example EasyPost) without waiting for a refetch.
 *
 * Read-only: no DB, no network, no provider calls.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve('web/src/components/Views/OrdersView.tsx');
const source = readFileSync(file, 'utf8');
const applyStart = source.indexOf('function applyRateSelection(');
const applyEnd = source.indexOf('\n  async function printPicklist', applyStart);
const block = applyStart >= 0 && applyEnd > applyStart ? source.slice(applyStart, applyEnd) : '';

const checks = [
  {
    name: 'applyRateSelection captures current auto-rate request',
    ok: /const autoRequest = panelOrder \? getAutoBestRateRequest\(panelOrder\) : null/.test(block),
  },
  {
    name: 'manual selection builds table-ready metadata',
    ok:
      /const rateForTable = autoRequest\s*\?\s*withRateRequestMetadata\(rate, autoRequest, \{[\s\S]*matchType: 'manual'/.test(block),
  },
  {
    name: 'manual selection seeds autoBestRateEntries for table cells',
    ok:
      /setAutoBestRateEntries\(\(current\) => \(\{[\s\S]*\[panelOrderId\]: \{ key: autoRequest\.key, rate: rateForTable \}/.test(block),
  },
  {
    name: 'manual selection preview uses table-ready rate',
    ok: /setPanelRatePreview\(\[rateForTable\]\)/.test(block),
  },
  {
    name: 'manual selection persists selected rate with request metadata',
    ok:
      /persistAppliedRateForOrder\(panelOrderId \?\? 0, rate,[\s\S]*request: autoRequest,[\s\S]*matchType: 'manual'/.test(block),
  },
];

let failures = 0;
for (const check of checks) {
  if (check.ok) {
    console.log(`ok   ${check.name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${check.name}`);
  }
}

if (failures > 0) {
  console.error(`\nFAIL rate-browser manual-selection table sync guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS rate-browser manual-selection table sync guard');
