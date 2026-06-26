/**
 * PS-335 guard - Rate Browser live quote single-flight.
 *
 * Production evidence: identical /rates/browse live requests can overlap while
 * ShipStation/direct carrier quotes are still pending, making the UI feel stuck.
 * The backend rate-shopping boundary must collapse identical in-flight provider
 * fan-outs without changing rate ranking, proof stamping, or UI ownership.
 */
import { readFileSync } from 'node:fs';
import {
  buildRateBrowseSingleFlightKey,
  runRateBrowseSingleFlight,
} from '../src/services/rate-browse-singleflight';
import { DIRECT_CARRIER_QUOTE_TIMEOUT_MS } from '../src/services/rates-combined';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail == null ? '' : ` - ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

async function main() {
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const producerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = runRateBrowseSingleFlight('same-key', async () => {
    calls += 1;
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { value: 42 };
  });
  const second = runRateBrowseSingleFlight('same-key', async () => {
    calls += 1;
    return { value: 99 };
  });
  await producerStarted;
  release();
  const [a, b] = await Promise.all([first, second]);

  check('identical in-flight browse requests share one provider fan-out', calls === 1, { calls });
  check('shared callers receive the same resolved value', a.value === 42 && b.value === 42, { a, b });

  let distinctCalls = 0;
  await Promise.all([
    runRateBrowseSingleFlight('distinct-a', async () => {
      distinctCalls += 1;
      return 'a';
    }),
    runRateBrowseSingleFlight('distinct-b', async () => {
      distinctCalls += 1;
      return 'b';
    }),
  ]);
  check('different browse keys do not collapse together', distinctCalls === 2, { distinctCalls });

  await runRateBrowseSingleFlight('retry-after-success', async () => 'first');
  const retryValue = await runRateBrowseSingleFlight('retry-after-success', async () => 'second');
  check('completed browse key is evicted for future refreshes', retryValue === 'second', { retryValue });

  let rejects = 0;
  try {
    await Promise.all([
      runRateBrowseSingleFlight('reject-key', async () => {
        rejects += 1;
        throw new Error('boom');
      }),
      runRateBrowseSingleFlight('reject-key', async () => {
        rejects += 1;
        return 'unexpected';
      }),
    ]);
  } catch {
    // Expected: shared failure propagates to all callers.
  }
  check('failed browse key still ran only one provider fan-out', rejects === 1, { rejects });
  const afterReject = await runRateBrowseSingleFlight('reject-key', async () => 'recovered');
  check('failed browse key is evicted for retry', afterReject === 'recovered', { afterReject });

  const keyA = buildRateBrowseSingleFlightKey({
    rateCacheKey: 'rate-key',
    forceLive: true,
    forceRefresh: true,
    cachedOnly: false,
    requestedCarrierIds: ['se-2', 'se-1'],
    directContext: { orderId: 123, purchaseOrderId: 'po-1' },
  });
  const keyB = buildRateBrowseSingleFlightKey({
    rateCacheKey: 'rate-key',
    forceLive: true,
    forceRefresh: true,
    cachedOnly: false,
    requestedCarrierIds: ['se-1', 'se-2'],
    directContext: { purchaseOrderId: 'po-1', orderId: 123 },
  });
  const keyC = buildRateBrowseSingleFlightKey({
    rateCacheKey: 'rate-key',
    forceLive: false,
    forceRefresh: false,
    cachedOnly: true,
    requestedCarrierIds: ['se-1', 'se-2'],
    directContext: { purchaseOrderId: 'po-1', orderId: 123 },
  });
  check('single-flight key is stable for equivalent carrier/context order', keyA === keyB, { keyA, keyB });
  check('single-flight key separates live and cached-only browse modes', keyA !== keyC, { keyA, keyC });
  check('direct-carrier quote timeout is bounded for interactive browse',
    DIRECT_CARRIER_QUOTE_TIMEOUT_MS <= 15_000,
    { DIRECT_CARRIER_QUOTE_TIMEOUT_MS });

  const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
  const pkg = readFileSync('package.json', 'utf8');

  check('/rates/browse imports the single-flight owner',
    /rate-browse-singleflight/.test(ratesRoute) &&
    /runRateBrowseSingleFlight/.test(ratesRoute));
  check('/rates/browse wraps the provider fan-out, not ranking/proof logic',
    /await runRateBrowseSingleFlight\([\s\S]{0,900}Promise\.all\(\[/.test(ratesRoute) &&
    /const \{ result, directRates, shipStationDurationMs, directCarrierDurationMs \} = await runRateBrowseSingleFlight/.test(ratesRoute));
  check('package.json exposes test:ps-335-rate-browser-singleflight',
    /test:ps-335-rate-browser-singleflight/.test(pkg));

  if (failures > 0) {
    console.error(`\nFAIL PS-335 rate-browser single-flight guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-335 rate-browser single-flight guard');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
