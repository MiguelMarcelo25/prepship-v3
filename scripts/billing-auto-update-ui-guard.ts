import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const filters = readFileSync('web/src/components/Views/BillingFilters.tsx', 'utf8');
const view = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
const details = readFileSync('web/src/components/Views/BillingDetailTable.tsx', 'utf8');

check('BillingFilters exposes one visible billing action: Update Billing',
  /'Update Billing'/.test(filters) &&
    !/Regenerate Range|Backfill Ref Rates|Fetch Ref Rates/.test(filters));

check('BillingFilters no longer accepts hidden manual ref-rate/regenerate handlers',
  !/onRegenerate|onBackfillRefRates|onFetchRefRates|regenerateRangeBlocked|backfillLoading|fetchRefRunning|fetchRefStatus/.test(filters));

check('BillingView owns a 3 minute automatic billing update interval',
  /BILLING_AUTO_UPDATE_MS\s*=\s*3\s*\*\s*60_000/.test(view) &&
    /window\.setInterval\([\s\S]*BILLING_AUTO_UPDATE_MS/.test(view) &&
    /autoBillingUpdateRef\.current\(\)/.test(view));

check('Automatic billing update uses the same Update Billing owner silently',
  /autoBillingUpdateRef\.current\s*=\s*\(\)\s*=>\s*\{\s*void handleGenerateBilling\(\{\s*silent:\s*true\s*\}\)/.test(view));

const billingFiltersCallStart = view.indexOf('<BillingFilters');
const billingFiltersCallEnd = billingFiltersCallStart >= 0 ? view.indexOf('/>', billingFiltersCallStart) : -1;
const billingFiltersCall = billingFiltersCallStart >= 0 && billingFiltersCallEnd > billingFiltersCallStart
  ? view.slice(billingFiltersCallStart, billingFiltersCallEnd)
  : '';

check('BillingView wires BillingFilters to Update Billing only',
  /onGenerate=\{\(\) => void handleGenerateBilling\(\)\}/.test(billingFiltersCall) &&
    !/onRegenerate|onBackfillRefRates|onFetchRefRates|regenerateRangeBlocked|backfillLoading|fetchRefRunning|fetchRefStatus/.test(billingFiltersCall));

check('Billing detail stale guidance points to Update Billing only',
  !/Regenerate Range/.test(details));

if (failures > 0) {
  console.error(`\nFAIL billing auto-update UI guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS billing auto-update UI guard');
