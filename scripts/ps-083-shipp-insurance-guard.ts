/**
 * PS-083 Guard — Shipp declares insured value via packageLineItems[].customsValue.
 *
 * Shipp's API now accepts a declared value on the PackageLineItem (customsValue).
 * Previously our connector hard-coded `insurance: false` (dropping Shipp for any
 * insured order, e.g. HUGRAB $100) and `customsValue.amount: 0`. This guard locks
 * the two corrected behaviours:
 *   1. Shipp now PASSES the shipping-option gate when insurance is requested.
 *   2. The declared value mapping (insuranceProvider/insuredValue -> customsValue
 *      amount) is correct and safe (0 when not insured / invalid).
 *
 *   npx tsx scripts/ps-083-shipp-insurance-guard.ts
 *
 * Read-only: no DB, no carrier IO, never buys a label. Pure logic only.
 */
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { createShippCarrierConnector, shippDeclaredValue } from '../src/connectors/carrier/shipp.js';
import { assertUnsupportedShippingOptions } from '../src/connectors/carrier/shipping-option-support.js';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
function expectThrows(name: string, fn: () => unknown, fragment: string) {
  try {
    fn();
    failures += 1;
    console.error(`FAIL ${name}: expected a throw, none happened`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(fragment)) {
      console.log(`ok   ${name}`);
    } else {
      failures += 1;
      console.error(`FAIL ${name}: threw "${message}", expected to include "${fragment}"`);
    }
  }
}
function expectNoThrow(name: string, fn: () => unknown) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: unexpected throw "${err instanceof Error ? err.message : String(err)}"`);
  }
}

type CapturedRequest = {
  url: string;
  body: unknown;
};

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

async function withMockFetch<T>(
  capture: CapturedRequest[],
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    capture.push({ url, body: parseBody(init) });
    return handler(url, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readNestedObject(value: unknown, path: string[]): Record<string, unknown> {
  let current: unknown = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else {
      current = readObject(current)[segment];
    }
  }
  return readObject(current);
}

async function minimalPdfBase64(): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([288, 432]);
  page.drawText('TEST LABEL', { x: 24, y: 384, size: 12 });
  return Buffer.from(await pdf.save()).toString('base64');
}

async function captureShippLabelPayload(insuranceProvider: string, insuredValue: number | null) {
  const capture: CapturedRequest[] = [];
  const labelPdf = await minimalPdfBase64();
  const connector = createShippCarrierConnector();

  await withMockFetch(
    capture,
    async (url) => {
      if (url.includes('/api/supabase/login')) {
        return jsonResponse({ session: { access_token: 'access-token', refresh_token: 'refresh-token' } });
      }
      if (url.includes('api.zippopotam.us')) {
        return jsonResponse({ places: [{ 'place name': 'Oakland', 'state abbreviation': 'CA' }] });
      }
      if (url.includes('/api/shipping/quote')) {
        return jsonResponse({
          rates: [
            {
              carrierType: 'UPS',
              serviceName: 'Ground',
              serviceType: 'GND',
              price: 10.14,
              quoted_shipment_id: 'quote-ups-ground',
            },
          ],
        });
      }
      if (url.includes('/api/shipping/label/create')) {
        return jsonResponse({
          label: {
            data: {
              tracking_number: '1ZTEST000000000001',
              packages: [{ label: labelPdf, label_format: 'application/pdf' }],
            },
          },
        });
      }
      return jsonResponse({ error: `unexpected url ${url}` }, 500);
    },
    () =>
      connector.createLabel({
        credentials: {
          apiKey: 'api-key',
          email: 'ops@example.com',
          password: 'password',
          shipFromCity: 'Carson',
          shipFromState: 'CA',
        },
        serviceCode: 'shipp_ups_ground',
        weightOz: 16,
        dimsL: 12,
        dimsW: 8,
        dimsH: 4,
        toZip: '94601',
        rawOrder: {
          shipTo: {
            name: 'Buyer',
            street1: '1 Main St',
            city: 'Oakland',
            state: 'CA',
            postalCode: '94601',
            country: 'US',
          },
        },
        shippingOptions: { insuranceProvider, insuredValue },
      }),
  );

  const quote = capture.find((request) => request.url.includes('/api/shipping/quote'));
  const label = capture.find((request) => request.url.includes('/api/shipping/label/create'));
  return {
    quoteCustomsValue: readNestedObject(quote?.body, ['packageLineItems', '0', 'customsValue']),
    labelCustomsValue: readNestedObject(label?.body, ['customsValue']),
  };
}

// ── Declared-value mapping (insuredValue -> customsValue.amount) ──────────────
check('insured carrier $100 => declares 100', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: 100 }), 100);
check('insured carrier $49.95 => declares 49.95', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: 49.95 }), 49.95);
check('no insurance => declares 0', shippDeclaredValue({ insuranceProvider: 'none', insuredValue: 100 }), 0);
check('insured but $0 => declares 0', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: 0 }), 0);
check('insured but null value => declares 0', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: null }), 0);
check('insured but negative => declares 0', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: -5 }), 0);
check('empty options => declares 0', shippDeclaredValue({}), 0);

// ── The gate: Shipp now ACCEPTS an insured order (insurance: true) ────────────
expectNoThrow('insured order passes the Shipp gate (insurance: true)', () =>
  assertUnsupportedShippingOptions(
    'Shipp',
    { insuranceProvider: 'carrier', insuredValue: 100 },
    { confirmation: ['delivery', 'none'], insurance: true },
  ),
);

// Regression doc: with insurance disabled, the gate still rejects (proves the
// gate is real and we genuinely flipped Shipp, not weakened the gate globally).
expectThrows(
  'gate still rejects insurance when a carrier opts out',
  () =>
    assertUnsupportedShippingOptions(
      'Shipp',
      { insuranceProvider: 'carrier', insuredValue: 100 },
      { confirmation: ['delivery', 'none'], insurance: false },
    ),
  'insurance is not supported by Shipp',
);

// Confirmation support is unchanged: Shipp only supports delivery/none.
expectThrows(
  'signature confirmation is still rejected for Shipp',
  () =>
    assertUnsupportedShippingOptions(
      'Shipp',
      { confirmation: 'signature', insuranceProvider: 'none' },
      { confirmation: ['delivery', 'none'], insurance: true },
    ),
  'is not supported by Shipp',
);

// A non-insured order still passes cleanly with insurance enabled.
expectNoThrow('non-insured order still passes the gate', () =>
  assertUnsupportedShippingOptions(
    'Shipp',
    { confirmation: 'delivery', insuranceProvider: 'none' },
    { confirmation: ['delivery', 'none'], insurance: true },
  ),
);

const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
{
  const callStart = ratesRoute.indexOf('const directRates = await getDirectCarrierRatesForRateInput({');
  const callEnd = ratesRoute.indexOf('}, { cachedOnly: isCachedOnlyLookup });', callStart);
  const directFanoutCall = callStart >= 0 && callEnd > callStart ? ratesRoute.slice(callStart, callEnd) : '';
  check(
    '/rates/browse direct fanout forwards resolved insurance provider',
    /insuranceProvider:\s*result\.effectiveInsuranceProvider/.test(directFanoutCall),
    true,
  );
  check(
    '/rates/browse direct fanout forwards resolved insured value',
    /insuredValue:\s*result\.effectiveInsuredValue/.test(directFanoutCall),
    true,
  );
  check(
    '/rates/browse direct fanout carries effective insurance provider metadata',
    /effectiveInsuranceProvider:\s*result\.effectiveInsuranceProvider/.test(directFanoutCall),
    true,
  );
  check(
    '/rates/browse direct fanout carries effective insured value metadata',
    /effectiveInsuredValue:\s*result\.effectiveInsuredValue/.test(directFanoutCall),
    true,
  );
}

async function run() {
  const insuredPayload = await captureShippLabelPayload('carrier', 100);
  check('quote payload sends customsValue.amount for insured Shipp labels', insuredPayload.quoteCustomsValue.amount, 100);
  check('quote payload sends customsValue.currency for insured Shipp labels', insuredPayload.quoteCustomsValue.currency, 'USD');
  check('label-create payload sends customsValue.amount for insured Shipp labels', insuredPayload.labelCustomsValue.amount, 100);
  check('label-create payload sends customsValue.currency for insured Shipp labels', insuredPayload.labelCustomsValue.currency, 'USD');

  const uninsuredPayload = await captureShippLabelPayload('none', null);
  check('quote payload sends customsValue.amount 0 for uninsured Shipp labels', uninsuredPayload.quoteCustomsValue.amount, 0);
  check('quote payload sends customsValue.currency for uninsured Shipp labels', uninsuredPayload.quoteCustomsValue.currency, 'USD');
  check('label-create payload sends customsValue.amount 0 for uninsured Shipp labels', uninsuredPayload.labelCustomsValue.amount, 0);
  check('label-create payload sends customsValue.currency for uninsured Shipp labels', uninsuredPayload.labelCustomsValue.currency, 'USD');

  if (failures > 0) {
    console.error(`\nFAIL PS-083 Shipp insurance guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-083 Shipp insurance guard');
}

run().catch((err) => {
  console.error('FAIL PS-083 Shipp insurance guard threw:', err);
  process.exit(1);
});
