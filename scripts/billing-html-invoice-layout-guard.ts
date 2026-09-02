/**
 * Guard: the HTML/PDF invoice table stays operator-friendly.
 * - Ship Date is wide enough and non-wrapping.
 * - Prep Fee Waiver is not a trailing table column in the HTML invoice.
 *
 * CSV/XLSX export/audit waiver markers are guarded separately.
 */
import { readFileSync } from 'node:fs';
import { INVOICE_COLUMNS } from '../src/routes/billing-invoice-columns';
import { INVOICE_SHIP_DATE_HEADER } from '../src/routes/billing-invoice-text';

const route = readFileSync('src/routes/billing.ts', 'utf8');
const htmlStart = route.indexOf('function renderInvoiceHtml(');
const htmlEnd = route.indexOf("app.get('/invoice'", htmlStart);
const html = htmlStart >= 0 && htmlEnd > htmlStart ? route.slice(htmlStart, htmlEnd) : '';

let failures = 0;

function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

check('HTML invoice renderer was found', html.length > 0);
// The header row is no longer hand-written in the template — all three artifacts derive their
// columns from one contract (billing-invoice-columns.ts), which is what stopped the HTML, XLSX
// and CSV carrying different columns under different names. So this can no longer pin the
// literal <th> and instead asserts the two facts it was really protecting: the date column is
// FIRST, and the generated header row marks it with the ship-date class the width rule below
// depends on.
check('the Billing / Activity Date column is first in the shared column contract',
  INVOICE_COLUMNS[0]?.header === INVOICE_SHIP_DATE_HEADER,
  `first column is ${INVOICE_COLUMNS[0]?.header}`);
check('HTML invoice marks the first header cell with the ship-date class',
  // The CALL is inside renderInvoiceHtml; the helper itself lives just above it, outside the
  // slice, so the class rule is checked against the whole file.
  /\$\{invoiceHeaderCellsHtml\(\)\}/.test(html)
  && /index === 0[\s\S]{0,160}class="ship-date"/.test(route));
check('HTML invoice marks Billing / Activity Date cells with the ship-date class', /<td class="ship-date">\$\{dateCell\}<\/td>/.test(html));
check(
  'HTML invoice preserves both backend billing and actual activity dates when they differ',
  /`Billed \$\{billingDate\}<br><small>Fulfilled \$\{actualDate\}<\/small>`/.test(html),
);
// This used to pin the literal "118px; min-width: 118px; white-space: nowrap". The fit-the-page
// layout (r8) sizes columns in percentages under table-layout: fixed, so the fact protected is
// the OUTCOME: the date column has a dedicated width rule (so it cannot collapse) and the table
// is fixed-layout at full width (so every column stays on the page).
check(
  'HTML invoice gives the Ship Date column a dedicated width rule',
  /th\.ship-date,\s*td\.ship-date\s*\{[^}]*width:\s*[0-9.]+(px|%);[^}]*\}/s.test(html),
);
check(
  'HTML invoice table is fixed-layout at full width, so all columns fit the page (screen and print)',
  /table\s*\{[^}]*width:\s*100%;[^}]*table-layout:\s*fixed;[^}]*\}/s.test(html) && /@page\s*\{[^}]*size:\s*landscape/.test(html),
);
check('HTML invoice table no longer renders the Prep Fee Waiver header', !/WAIVED_COLUMN_HEADER/.test(html));
check('HTML invoice table no longer renders waiver cells or badges', !/waiver-cell|waiver-badge|waivedCellText\(/.test(html));
check('HTML invoice keeps the period-level waiver note', /waiverNote/.test(html) && /waiver-note/.test(html));

if (failures > 0) {
  console.error(`\nFAIL billing HTML invoice layout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS billing HTML invoice layout guard');
