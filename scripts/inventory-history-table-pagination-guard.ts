/**
 * Guard: the Inventory History tab uses the shared Table component with
 * sortable, width-resizable (persisted) columns and 50/100/200 pagination
 * (default 50).
 *
 * The shared Table (web/src/components/ui/Table.tsx) provides sortable headers
 * and drag-resizable column widths persisted under storageKey. This guard pins
 * the History usage to that component with the requested pagination options.
 */
import { readFileSync } from 'node:fs';

const view = readFileSync('web/src/components/Views/InventoryView.tsx', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// Isolate the History tab's <Table ...> usage (the one bound to `ledger`).
const start = view.indexOf('<Table<InventoryLedgerEntryDto>');
const end = start >= 0 ? view.indexOf('/>', start) : -1;
const block = start >= 0 && end > start ? view.slice(start, end) : '';

check('History renders the shared Table component', block.length > 0 && /data=\{ledger\}/.test(block));
check('History columns come from historyColumns (sortable + width metadata)', /columns=\{historyColumns\}/.test(block));
check('History Table persists sort + column widths via storageKey', /storageKey="inventory-history-table"/.test(block));
check('History Table is paginated', /\bpaginated\b/.test(block));
check('History pagination options are 50 / 100 / 200', /pageSizeOptions=\{\[50, 100, 200\]\}/.test(block));
check('History default page size is 50', /defaultPageSize=\{50\}/.test(block));

// historyColumns must declare sortable columns with widths (sort + resize).
const colsStart = view.indexOf('const historyColumns = useMemo');
const colsEnd = colsStart >= 0 ? view.indexOf('], [', colsStart) : -1;
const cols = colsStart >= 0 && colsEnd > colsStart ? view.slice(colsStart, colsEnd) : '';
check('history columns are sortable', /sortable: true/.test(cols));
check('history columns declare widths (resizable)', /\bwidth: \d+/.test(cols));

if (failures > 0) {
  console.error(`\nFAIL inventory history table pagination guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS inventory history table pagination guard');
