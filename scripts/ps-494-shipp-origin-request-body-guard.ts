// PS-494 correction guard — the BEHAVIOURAL one the audit said was missing.
//
// The existing ps-494-customs-origin-guard proves the pure resolver and pins source
// patterns. It did not execute a Shipp quote and look at what actually goes on the wire,
// which is how "ordinary rate browsing still sends a guessed origin" survived a green run:
// every assertion was about code shape, and the shape was fine — the wiring was missing.
//
// This guard runs the real connector and captures the real request body by stubbing global
// fetch, which `timedFetch` wraps. Nothing leaves the process: the stub answers the login
// and quote calls itself, so there is no provider contact, no postage and no cost.
//
// Cases (exactly the five the audit asked for):
//   1. single KR origin        -> KR on the wire
//   2. mixed US/KR             -> REFUSED before any HTTP
//   3. unknown + domestic      -> operator default or 'US', explicitly allowed
//   4. unknown + international -> REFUSED before any HTTP
//   5. label-purchase pre-quote uses the same decision as browsing
//
// KNOWN LIMIT, stated rather than hidden. No single assertion here executes
// `getDirectCarrierRatesForRateInput` end to end into the connector. That entry point reads
// carrier accounts and the order row from the database and can WRITE the direct-rate cache,
// which a guard must not do. The path is therefore covered in two halves that meet in the
// middle: layer 3 proves behaviourally that a threaded origin reaches the wire, and layer 4
// proves by source that `rates.ts` does the threading and refuses without a provider fetch.
// Mutation testing confirms each half fails independently — cutting the thread in rates.ts
// trips layer 4, and making the connector ignore it trips layer 3. A reviewer wanting a
// single end-to-end execution needs a seeded throwaway database, not this guard.

import {
  assertDeclarableOrigin,
  CustomsOriginUndeclarableError,
  decideDeclaredOrigin,
  resolveOrderCustomsOrigin,
} from '../src/services/customs-origin';
import { quoteCarrierRates } from '../src/services/carrier-connector-orchestrator';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

const orderWith = (origins: Array<string | null>) => ({
  raw: {
    internationalOptions: {
      customsItems: origins.map((countryOfOrigin, i) => ({
        countryOfOrigin,
        description: `item ${i}`,
      })),
    },
  },
});

// ── Layer 1: the pure decision ────────────────────────────────────────────────
{
  const single = decideDeclaredOrigin({
    resolution: resolveOrderCustomsOrigin(orderWith(['KR', 'KR'])),
    destination: 'Domestic',
  });
  check('single KR resolves to a declared fact',
    single.kind === 'declare' && single.country === 'KR' && single.basis === 'resolved', single);

  const mixed = decideDeclaredOrigin({
    resolution: resolveOrderCustomsOrigin(orderWith(['US', 'KR'])),
    destination: 'Domestic',
  });
  check('a mixed carton REFUSES rather than guessing', mixed.kind === 'refuse', mixed);
  check('the mixed refusal names both origins',
    mixed.kind === 'refuse' && /US/.test(mixed.reason) && /KR/.test(mixed.reason), mixed);

  const unknownDomestic = decideDeclaredOrigin({
    resolution: resolveOrderCustomsOrigin(orderWith([])),
    destination: 'Domestic',
  });
  check('unknown + DOMESTIC declares the default, explicitly',
    unknownDomestic.kind === 'declare' && unknownDomestic.basis === 'domestic_default', unknownDomestic);

  const unknownIntl = decideDeclaredOrigin({
    resolution: resolveOrderCustomsOrigin(orderWith([])),
    destination: 'International',
  });
  check('unknown + INTERNATIONAL refuses — no guess on a real declaration',
    unknownIntl.kind === 'refuse', unknownIntl);

  const unknownReview = decideDeclaredOrigin({
    resolution: resolveOrderCustomsOrigin(orderWith([])),
    destination: 'Needs Review',
  });
  check('unknown + NEEDS REVIEW fails closed, it is not treated as domestic',
    unknownReview.kind === 'refuse', unknownReview);

  const configured = decideDeclaredOrigin({
    resolution: resolveOrderCustomsOrigin(orderWith([])),
    destination: 'Domestic',
    configuredDefault: 'CA',
  });
  check('the operator default is honoured on the domestic branch',
    configured.kind === 'declare' && configured.country === 'CA', configured);

  const resolvedBeatsDefault = decideDeclaredOrigin({
    resolution: resolveOrderCustomsOrigin(orderWith(['KR'])),
    destination: 'Domestic',
    configuredDefault: 'CA',
  });
  check('a resolved origin beats the configured default',
    resolvedBeatsDefault.kind === 'declare' && resolvedBeatsDefault.country === 'KR', resolvedBeatsDefault);
}

// ── Layer 2: the label-purchase assert refuses with a 4xx-carrying error ───────
{
  let thrown: unknown = null;
  try {
    assertDeclarableOrigin({
      resolution: resolveOrderCustomsOrigin(orderWith(['US', 'KR'])),
      destination: 'Domestic',
    });
  } catch (err) { thrown = err; }
  check('the label path THROWS on a mixed carton', thrown instanceof CustomsOriginUndeclarableError, String(thrown));
  check('the refusal carries a 4xx status so the operator sees the reason, not "Internal server error"',
    (thrown as { status?: number } | null)?.status === 422,
    (thrown as { status?: number } | null)?.status);

  check('the label path returns null on the domestic-inert branch, letting the adapter default',
    assertDeclarableOrigin({
      resolution: resolveOrderCustomsOrigin(orderWith([])),
      destination: 'Domestic',
    }) === null);

  check('the label path returns the resolved country as a fact',
    assertDeclarableOrigin({
      resolution: resolveOrderCustomsOrigin(orderWith(['CN'])),
      destination: 'Domestic',
    }) === 'CN');
}

// ── Layer 3: what actually goes on the wire ───────────────────────────────────
// Stub global fetch. `timedFetch` wraps it, so the connector runs for real up to the
// network boundary and we read the body it would have sent.
type Captured = { url: string; body: unknown };
const realFetch = globalThis.fetch;
let captured: Captured[] = [];

globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
  const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '');
  let parsed: unknown = null;
  try { parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : null; } catch { parsed = null; }
  captured.push({ url, body: parsed });
  if (url.includes('/supabase/login')) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'sb-access-token=stub; Path=/' },
    });
  }
  // An empty rate list is a valid provider answer; this guard is about the REQUEST.
  return new Response(JSON.stringify({ rates: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

async function quoteAndCapture(countryOfManufacture: string | null): Promise<unknown> {
  captured = [];
  const input: Record<string, unknown> = {
    credentials: { apiKey: 'stub-key', email: 'stub@example.com', password: 'stub-pass' },
    weightOz: 32, dimsL: 12, dimsW: 10, dimsH: 3,
    toZip: '90248', toCountry: 'US', toState: 'CA', toCity: 'Gardena',
    orderId: 1, orderNumber: 'GUARD-1',
  };
  if (countryOfManufacture != null) input.countryOfManufacture = countryOfManufacture;
  try { await quoteCarrierRates('shipp', input as never); } catch { /* transport shape is not under test */ }
  const quote = captured.find((c) => c.url.includes('/shipping/quote'));
  const lineItems = (quote?.body as { packageLineItems?: Array<Record<string, unknown>> } | undefined)?.packageLineItems;
  return lineItems?.[0]?.countryOfManufacture ?? null;
}

try {
  const sent = await quoteAndCapture('KR');
  check('RATE BROWSING transmits the resolved origin — the gap the audit found', sent === 'KR', sent);

  const fallback = await quoteAndCapture(null);
  check('with no resolved origin the adapter still sends its default on the domestic lane',
    fallback === 'US', fallback);
} finally {
  globalThis.fetch = realFetch;
}

// ── Layer 4: the wiring itself, so the thread cannot be quietly cut ───────────
{
  const ratesSrc = await import('node:fs').then((fs) =>
    fs.readFileSync('src/services/rates.ts', 'utf8'));
  check('rates.ts resolves the origin for shipp before quoting',
    /resolveShippDeclaredOrigin/.test(ratesSrc));
  check('rates.ts passes countryOfManufacture into the carrier quote input',
    /countryOfManufacture: shippOrigin/.test(ratesSrc));
  // The refusal branch must report zero provider fetches — that is the machine-readable
  // proof nothing was sent. Window is generous because the branch builds a full diagnostic;
  // what matters is that `providerFetches: 0` belongs to the refusal, not that it is close.
  const refuseBranch = ratesSrc.slice(
    ratesSrc.indexOf("kind === 'refuse'"),
    ratesSrc.indexOf('shippOrigin = decision.basis'),
  );
  check('rates.ts refuses WITHOUT a provider fetch',
    refuseBranch.length > 0 && /providerFetches: 0/.test(refuseBranch));
  check('the refusal reason reaches the operator instead of the sanitised string',
    /message: decision\.reason/.test(ratesSrc));

  const labelsSrc = await import('node:fs').then((fs) =>
    fs.readFileSync('src/services/labels.ts', 'utf8'));
  check('the label path asserts a declarable origin before any provider call',
    /assertDeclarableOrigin\(\{/.test(labelsSrc));
  check('the label path no longer silently collapses mixed/unknown to a default',
    !/singleCustomsOriginOrNull/.test(labelsSrc));
}

if (failures > 0) {
  console.error(`\nPS-494 Shipp origin request-body guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPASS PS-494 Shipp origin request-body guard');
console.log('No provider contacted. No postage. No writes.');
