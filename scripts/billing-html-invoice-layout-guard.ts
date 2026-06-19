/**
 * Guard: the HTML/PDF invoice table stays operator-friendly.
 * - Ship Date is wide enough and non-wrapping.
 * - Prep Fee Waiver is not a trailing table column in the HTML invoice.
 *
 * CSV/XLSX export/audit waiver markers are guarded separately.
 */
import { readFileSync } from 'node:fs';

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
check('HTML invoice marks Ship Date header with the ship-date class', /<th class="ship-date">Ship Date<\/th>/.test(html));
check('HTML invoice marks Ship Date cells with the ship-date class', /<td class="ship-date">\$\{escHtml\(shipDate\)\}<\/td>/.test(html));
check(
  'HTML invoice Ship Date column is widened and non-wrapping',
  /th\.ship-date,\s*td\.ship-date\s*\{[^}]*width:\s*118px;[^}]*min-width:\s*118px;[^}]*white-space:\s*nowrap;[^}]*\}/s.test(html),
);
check('HTML invoice table no longer renders the Prep Fee Waiver header', !/WAIVED_COLUMN_HEADER/.test(html));
check('HTML invoice table no longer renders waiver cells or badges', !/waiver-cell|waiver-badge|waivedCellText\(/.test(html));
check('HTML invoice keeps the period-level waiver note', /waiverNote/.test(html) && /waiver-note/.test(html));

if (failures > 0) {
  console.error(`\nFAIL billing HTML invoice layout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS billing HTML invoice layout guard');
