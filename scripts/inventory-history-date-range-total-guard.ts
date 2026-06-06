/**
 * Guard: Inventory History must let the table represent every movement in the
 * selected date range, not only the first 200 rows returned by one API page.
 *
 * The shared Table paginates its local `ledger` array, so the compatibility
 * client must auto-page `/inventory/ledger` before returning rows to
 * InventoryView.
 */
import { readFileSync } from 'node:fs';

const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const parity = readFileSync('web/src/components/Views/inventory-parity.ts', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const fetchStart = apiClient.indexOf('fetchInventoryLedger(query: Record<string, unknown>)');
const fetchEnd = fetchStart >= 0 ? apiClient.indexOf('deleteInventoryLedgerEntry', fetchStart) : -1;
const fetchBlock = fetchStart >= 0 && fetchEnd > fetchStart ? apiClient.slice(fetchStart, fetchEnd) : '';

const buildStart = parity.indexOf('export function buildInventoryLedgerQuery');
const buildEnd = buildStart >= 0 ? parity.indexOf('export function buildBulkDimensionUpdates', buildStart) : -1;
const buildBlock = buildStart >= 0 && buildEnd > buildStart ? parity.slice(buildStart, buildEnd) : '';

check('Inventory History fetch helper exists', fetchBlock.length > 0);
check('Inventory History query builder exists', buildBlock.length > 0);
check('History query no longer hard-codes limit 200', !/\{\s*limit:\s*200\s*\}/.test(buildBlock));
check('History ledger fetch requests a page size above the old 200-row ceiling', /PAGE_SIZE\s*=\s*2000/.test(fetchBlock));
check('History ledger fetch reads pagination metadata', /pagination/.test(fetchBlock) && /totalPages/.test(fetchBlock));
check('History ledger fetch requests remaining pages', /Promise\.all/.test(fetchBlock) && /page\s*<=\s*pageCap/.test(fetchBlock));
check('History ledger fetch preserves selected filters while paging', /\.\.\.\(query \?\? \{\}\).*pageSize:\s*PAGE_SIZE,\s*page:\s*1/s.test(fetchBlock));

if (failures > 0) {
  console.error(`\nFAIL inventory history date range total guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS inventory history date range total guard');
