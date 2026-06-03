/**
 * Guard: Manifest Export produces a real, column-laid-out CSV.
 *
 * The endpoint returns JSON; the download saved that JSON to a .csv so Excel
 * dumped the whole blob into one cell. buildManifestCsv turns the shipment rows
 * into a header + one row each with RFC-4180 escaping. This locks that.
 *
 *   npx tsx scripts/manifest-csv-guard.ts
 *
 * Read-only: pure, mutates nothing.
 */
import {
  buildManifestCsv,
  escapeManifestCsvCell,
  manifestRowsFromResponse,
} from '../web/src/components/Views/manifests-parity';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// Response unwrapping.
check('unwraps { data: [...] }', manifestRowsFromResponse({ data: [{ id: 1 }] }).length === 1);
check('accepts a bare array', manifestRowsFromResponse([{ id: 1 }, { id: 2 }]).length === 2);
check('null/garbage => []', manifestRowsFromResponse(null).length === 0 && manifestRowsFromResponse({}).length === 0);

// CSV escaping.
check('plain value not quoted', escapeManifestCsvCell('ups') === 'ups');
check('comma value is quoted', escapeManifestCsvCell('a,b') === '"a,b"');
check('quote value is escaped + quoted', escapeManifestCsvCell('a"b') === '"a""b"');
check('newline value is quoted', escapeManifestCsvCell('a\nb') === '"a\nb"');

// Header-only for empty input.
const empty = buildManifestCsv([]);
check('empty rows => header only', empty === 'Ship Date,Order #,Client ID,Carrier,Service,Tracking #,Weight (oz),Label Cost');

// Full row rendering.
const csv = buildManifestCsv([
  {
    id: 23510,
    orderId: 714079,
    orderNumber: '114-0729995-0375435',
    clientId: 11,
    carrierCode: 'ups',
    serviceCode: 'ups_surepost_1_lb_or_greater',
    trackingNumber: '1ZR05H19YW00482781',
    shipDate: '2026-05-05T00:00:00.000Z',
    weightOz: 61,
    labelCost: null,
  },
  {
    orderNumber: 'A,B', // comma forces quoting
    clientId: 7,
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    trackingNumber: '9434650106151070435059',
    shipDate: '2026-05-06T12:00:00.000Z',
    weightOz: 122,
    labelCost: '3.5',
  },
]);
const lines = csv.split('\r\n');
check('CRLF row separators', csv.includes('\r\n') && lines.length === 3);
check('header is the first line', lines[0]!.startsWith('Ship Date,Order #'));
check('ship date sliced to YYYY-MM-DD', lines[1]!.startsWith('2026-05-05,'));
check('order number rendered', lines[1]!.includes('114-0729995-0375435'));
check('null label cost => empty cell', lines[1]!.endsWith(',')); // last column empty
check('comma order number is quoted', lines[2]!.includes('"A,B"'));
check('label cost formatted to 2dp', lines[2]!.endsWith(',3.50'));

if (failures > 0) {
  console.error(`\nFAIL manifest CSV guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS manifest CSV guard');
