import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function assertContains(source: string, needle: string, message: string): void {
  if (!source.includes(needle)) {
    throw new Error(`${message}\nMissing: ${needle}`);
  }
}

function assertRegex(source: string, pattern: RegExp, message: string): void {
  if (!pattern.test(source)) {
    throw new Error(`${message}\nMissing pattern: ${pattern}`);
  }
}

const reportingMetrics = read('src/services/reporting-metrics.ts');
const billing = read('src/services/billing.ts');

assertContains(
  reportingMetrics,
  'from scoped_clients sc',
  'Billing summary metrics must build freshness from the scoped active-client set, not from cache rows alone.'
);

assertContains(
  reportingMetrics,
  'from billing_line_items b',
  'Billing summary cache freshness must inspect the billing_line_items source of truth.'
);

assertContains(
  reportingMetrics,
  'max(b.created_at) as newest_line_item_created_at',
  'Billing summary cache freshness must compare metrics against the newest generated line item.'
);

assertContains(
  reportingMetrics,
  'newest_line_item_created_at <= updated_at',
  'Fresh cache rows must be rejected when billing_line_items has fresher rows in the same period.'
);

assertRegex(
  reportingMetrics,
  /fresh_count\s*<\s*expected_count[\s\S]*return null/,
  'getFreshBillingSummaryMetrics must reject partial cache coverage before returning summary rows.'
);

assertContains(
  billing,
  '[billing] refreshing stale or incomplete summary metrics from billing_line_items',
  'Billing summary must emit observability when stale or incomplete metrics trigger refresh from billing_line_items.'
);

console.log('PS-380 billing summary cache freshness guard passed.');
