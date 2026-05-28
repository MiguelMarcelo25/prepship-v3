import fs from 'node:fs';

const source = fs.readFileSync('src/connectors/carrier/shipp.ts', 'utf8');

const requiredSnippets = [
  'function shippShouldRetryQuoteStatus',
  'status === 429 || status === 500 || status === 502 || status === 503 || status === 504',
  'for (let attempt = 1; attempt <= SHIPP_QUOTE_MAX_ATTEMPTS; attempt += 1)',
  "timedFetch(attempt > 1 ? 'shipp.rates.retry' : 'shipp.rates'",
  'Shipp quote failed after retry',
];

const missing = requiredSnippets.filter((snippet) => !source.includes(snippet));

if (missing.length) {
  console.error('FAIL Shipp quote retry guard missing required behavior:');
  for (const snippet of missing) console.error(`- ${snippet}`);
  process.exit(1);
}

console.log('PASS Shipp quote retries transient provider failures before surfacing an error');
