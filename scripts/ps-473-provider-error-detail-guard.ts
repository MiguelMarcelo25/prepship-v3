// PS-473: a hard provider rejection must be legible without a log dive.
//
// 2026-07-30. A HUGRAB HU-10 order with an active hazmat declaration was
// filtered (correctly) to its one certified carrier, Stamps.com USPS, and got:
//
//   {"error": "Carrier rate request failed", "retryable": false,
//    "transient": false, "durationMs": 362}
//
// That string is OURS -- the terminal fallthrough of sanitizeRateProviderError,
// which maps provider errors onto a small fixed set so provider internals never
// reach operator/client-visible diagnostics. The sanitizer is correct and is
// deliberately NOT changed here.
//
// The cost was that a permanent refusal could not be told apart from any other
// failure: USPS declining dangerous goods outright, and our hazmat payload
// using a field their API rejects, looked identical. Different fixes.
//
// providerDetail adds the provider's own words, scrubbed and capped. This guard
// pins BOTH halves -- the detail survives, AND credentials never ride along.
import { readFileSync } from 'node:fs';
import { rateProviderErrorDetail } from '../src/services/rate-provider-error-detail.js';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const rates = readFileSync('src/services/rates.ts', 'utf8');
const sanitizer = readFileSync('src/services/rate-browser-timing-diagnostics.ts', 'utf8');

// --- it preserves the provider's actual words -----------------------------
check(
  'a provider rejection keeps its own text',
  rateProviderErrorDetail(new Error('Hazardous materials are not supported for this service'))
    === 'Hazardous materials are not supported for this service',
);
check(
  'plain string errors are handled',
  rateProviderErrorDetail('USPS rejected the dangerous goods declaration')
    ?.includes('dangerous goods') === true,
);
check(
  'nothing useful yields undefined, not an empty string',
  rateProviderErrorDetail(null) === undefined && rateProviderErrorDetail('   ') === undefined,
);
check(
  'newlines are collapsed so stored JSON stays one line',
  !(rateProviderErrorDetail(new Error('line one\nline two')) ?? '').includes('\n'),
);
check(
  'long text is capped',
  (rateProviderErrorDetail(new Error('x'.repeat(5000))) ?? '').length <= 400,
);
check(
  'a circular object cannot throw on the rating path',
  (() => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    try { rateProviderErrorDetail(circular); return true; } catch { return false; }
  })(),
);

// --- it never leaks credentials -------------------------------------------
const leaky = rateProviderErrorDetail(new Error(
  'POST https://api.shipstation.com/v2/rates failed: api_key=SS_live_9f3c2b7a41d84e6fa0c15d83ba77e219 '
  + 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9zzzzzzzzzzzzzzzz '
  + 'contact ops@drprepperusa.com or https://user:hunter2@internal.example.com/x',
)) ?? '';
check('api keys are redacted', !leaky.includes('SS_live_9f3c2b7a41d84e6fa0c15d83ba77e219'));
check('bearer tokens are redacted', !leaky.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
check('emails are redacted', !leaky.includes('ops@drprepperusa.com'));
check('url credentials are redacted', !leaky.includes('hunter2'));
check(
  'the useful part of the message still survives redaction',
  leaky.includes('rates') && leaky.includes('failed'),
);

// --- wiring ---------------------------------------------------------------
check(
  'the failed-carrier diagnostic carries providerDetail',
  /providerDetail\?: string;/.test(rates)
    && rates.includes('const detail = rateProviderErrorDetail(err)'),
);
check(
  'the cache read-back rebuild does not drop providerDetail',
  /providerDetail: typeof row\.providerDetail === 'string'/.test(rates),
);
check(
  'providerDetail is additive -- the sanitized category is still set',
  rates.includes('error: message,'),
);
// The sanitizer is the client-facing contract and must not be loosened to
// "fix" visibility; this ticket adds a channel rather than widening that one.
check(
  'sanitizeRateProviderError still collapses to fixed safe categories',
  sanitizer.includes("return 'Carrier rate request failed';")
    && sanitizer.includes("return 'Carrier account authorization failed';"),
);

if (failures > 0) {
  console.error(`\nFAIL PS-473 provider error detail guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-473 provider error detail guard');
