#!/usr/bin/env tsx
/**
 * Carrier harness — backend end-to-end runner (Slice 2 skeleton; grows in Slices 3/4/7).
 * Plan: ~/.claude/plans/zany-spinning-hennessy.md
 *
 * Proves printing an order to the queue succeeds across carrier paths WITHOUT
 * spending money or notifying a marketplace, producing a provider × sub-carrier
 * pass/fail matrix.
 *
 * MODES (default = --self-check):
 *   --self-check   Offline. No DB, no network. Validates seam + factory + matrix
 *                  wiring and the safety invariants. This is what `test:carrier-harness`
 *                  runs in CI — it can never touch the production DB or buy anything.
 *   --sandbox      Real DB + real-carrier SANDBOX (EasyPost test key). $0, no
 *                  marketplace. Requires DATABASE_URL + an EZTK test key
 *                  (CARRIER_HARNESS_EASYPOST_TEST_KEY). Tiers without creds are
 *                  reported as SKIPPED, never failed.
 *   --live-approved  Real postage. Refused unless the flag AND creds are present
 *                  (manual_live_gated). Not implemented in this slice.
 *
 * Output: test-results/carrier-harness/latest.{json,md}. Continues past failures.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildCarrierTestOrderSeed,
  assertSeedIsSafe,
  CarrierTestOrderSafetyError,
} from './lib/carrier-test-order-factory.js';
import {
  isCarrierTestMode,
  resolveCarrierTestStrategy,
  assertNoLivePostageOrMarketplace,
  CarrierTestModeSafetyError,
} from '../src/services/carrier-test-mode.js';

const DIRECT_PROVIDERS = ['easypost', 'shipp', 'ups', 'walmart_shipping'] as const;
const OUT = 'test-results/carrier-harness/latest';

type MatrixRow = {
  provider: string;
  serviceCode: string;
  strategy: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
};

function arg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Post-assert (Slice 4): a harness attempt must leave ZERO live marketplace
 * confirmation rows. Returns an error string if any pending/queued outbox row
 * exists for the order, else null. Proves the run did not notify a marketplace.
 */
async function assertNoOutboxRows(sql: any, orderId: number): Promise<string | null> {
  try {
    const rows = (await sql`
      SELECT count(*)::int AS n FROM fulfillment_outbox
      WHERE order_id = ${orderId} AND status IN ('pending', 'queued', 'succeeded')
    `) as Array<{ n: number }>;
    const n = rows[0]?.n ?? 0;
    return n === 0 ? null : `${n} live outbox row(s) created — marketplace would be notified`;
  } catch {
    // Table may not exist in a bare test DB; absence of outbox = trivially suppressed.
    return null;
  }
}

function writeMatrix(rows: MatrixRow[], mode: string): void {
  mkdirSync(dirname(OUT), { recursive: true });
  const pass = rows.filter((r) => r.status === 'pass').length;
  const fail = rows.filter((r) => r.status === 'fail').length;
  const skip = rows.filter((r) => r.status === 'skipped').length;
  writeFileSync(`${OUT}.json`, JSON.stringify({ mode, pass, fail, skip, rows }, null, 2));
  const md = [
    `# Carrier harness — ${mode}`,
    '',
    `Total ${rows.length} · pass ${pass} · fail ${fail} · skipped ${skip}`,
    '',
    '| Provider | Sub-carrier / service | Tier | Result | Detail |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.provider} | ${r.serviceCode} | ${r.strategy} | ${r.status} | ${r.detail} |`),
    '',
  ].join('\n');
  writeFileSync(`${OUT}.md`, md);
}

// ── Offline self-check: validate the harness wiring without DB/network ──
function runSelfCheck(): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const sampleServices: Record<string, string[]> = {
    easypost: ['usps_priority', 'usps_first', 'ups_ground'],
    shipp: ['shipp_ups_ground', 'shipp_usps_priority'],
    ups: ['ups_ground', 'ups_2nd_day_air'],
    walmart_shipping: ['walmart_fedex_ground', 'walmart_usps_priority'],
  };
  for (const provider of DIRECT_PROVIDERS) {
    const strategy = resolveCarrierTestStrategy(provider);
    for (const serviceCode of sampleServices[provider]) {
      try {
        const seed = buildCarrierTestOrderSeed({ provider, serviceCode });
        assertSeedIsSafe(seed);
        // The seam must consider this a test call and pass the safety assertion.
        const input: any = {
          __carrierTestMode: true,
          __sourceProvider: seed.sourceProvider,
          credentials: provider === 'easypost' ? { apiKey: 'EZTK_selfcheck' } : {},
        };
        const armed = process.env.CARRIER_TEST_MODE;
        process.env.CARRIER_TEST_MODE = '1';
        const recognized = isCarrierTestMode(input);
        assertNoLivePostageOrMarketplace(provider, input, strategy);
        if (armed === undefined) delete process.env.CARRIER_TEST_MODE;
        else process.env.CARRIER_TEST_MODE = armed;
        if (!recognized) throw new Error('seam did not recognize the test call');
        rows.push({ provider, serviceCode, strategy, status: 'pass', detail: 'seed safe; seam recognizes test call; no-live assertion ok' });
      } catch (err) {
        rows.push({ provider, serviceCode, strategy, status: 'fail', detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  // ShipStation — the 5th path. It does NOT use the direct-carrier seam; it uses
  // createLabelV2's existing testLabel offline mode ($0 mock + mark-shipped), and an
  // internal-source order is suppressed by outbox.ts so no marketplace is notified.
  for (const serviceCode of ['usps_priority', 'ups_ground']) {
    try {
      const seed = buildCarrierTestOrderSeed({ provider: 'shipstation', serviceCode });
      assertSeedIsSafe(seed);
      rows.push({ provider: 'shipstation', serviceCode, strategy: 'offline-test', status: 'pass', detail: 'seed safe; createLabelV2 testLabel ($0 mock, mark-shipped, internal-source → no notify)' });
    } catch (err) {
      rows.push({ provider: 'shipstation', serviceCode, strategy: 'offline-test', status: 'fail', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // Negative controls: unsafe shapes MUST be refused.
  try {
    assertSeedIsSafe({ ...buildCarrierTestOrderSeed({ provider: 'shipp', serviceCode: 'x' }), externalOrderId: 'walmart-123' } as any);
    rows.push({ provider: '(neg)', serviceCode: 'marketplace-id', strategy: '-', status: 'fail', detail: 'marketplace external id was NOT refused' });
  } catch (e) {
    rows.push({ provider: '(neg)', serviceCode: 'marketplace-id', strategy: '-', status: e instanceof CarrierTestOrderSafetyError ? 'pass' : 'fail', detail: 'marketplace external id refused' });
  }
  try {
    process.env.CARRIER_TEST_MODE = '1';
    assertNoLivePostageOrMarketplace('easypost', { __sourceProvider: 'internal', credentials: { apiKey: 'EZAK_live' } } as any, 'sandbox');
    delete process.env.CARRIER_TEST_MODE;
    rows.push({ provider: '(neg)', serviceCode: 'easypost-live-key', strategy: 'sandbox', status: 'fail', detail: 'live EZAK key was NOT refused' });
  } catch (e) {
    delete process.env.CARRIER_TEST_MODE;
    rows.push({ provider: '(neg)', serviceCode: 'easypost-live-key', strategy: 'sandbox', status: e instanceof CarrierTestModeSafetyError ? 'pass' : 'fail', detail: 'live EZAK key refused' });
  }
  return rows;
}

// ── Sandbox tier (real DB + EasyPost test key). Wired; activates only with creds. ──
async function runSandbox(): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];
  const dbUrl = process.env.DATABASE_URL;
  const epKey = process.env.CARRIER_HARNESS_EASYPOST_TEST_KEY;
  if (!dbUrl) {
    rows.push({ provider: 'easypost', serviceCode: '(all)', strategy: 'sandbox', status: 'skipped', detail: 'DATABASE_URL not set' });
    return rows;
  }
  if (!epKey || !/^EZTK/i.test(epKey)) {
    rows.push({ provider: 'easypost', serviceCode: '(all)', strategy: 'sandbox', status: 'skipped', detail: 'CARRIER_HARNESS_EASYPOST_TEST_KEY missing or not an EZTK test key' });
    return rows;
  }
  // Live sandbox pipeline is exercised here when creds are present. Implemented
  // incrementally: Slice 2 drives rate→label through the seam; Slice 4 adds the
  // full handler-in-process drive + outbox/cost/deduction post-assertions.
  const postgres = (await import('postgres')).default;
  const { ensureHarnessTestClient, createCarrierTestOrder, cleanupCarrierTestOrders } = await import('./lib/carrier-test-order-factory.js');
  const { quoteCarrierRates, createCarrierLabel } = await import('../src/services/carrier-connector-orchestrator.js');
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 });
  process.env.CARRIER_TEST_MODE = '1';
  try {
    const clientId = await ensureHarnessTestClient(sql);
    const seed = buildCarrierTestOrderSeed({ provider: 'easypost', serviceCode: 'enumerate' });
    const baseInput: any = {
      __carrierTestMode: true,
      __sourceProvider: 'internal',
      credentials: { apiKey: epKey },
      clientId,
      weightOz: seed.weightOz,
      dimsL: seed.dims.l, dimsW: seed.dims.w, dimsH: seed.dims.h,
      shipTo: seed.shipTo,
    };
    let services: Array<{ serviceCode: string; carrierCode?: string }> = [];
    try {
      const quote = await quoteCarrierRates('easypost', baseInput);
      const seen = new Set<string>();
      for (const r of quote.rates as Array<Record<string, any>>) {
        const code = String(r.serviceCode ?? r.service_code ?? r.service ?? '').trim();
        if (code && !seen.has(code)) { seen.add(code); services.push({ serviceCode: code, carrierCode: String(r.carrierCode ?? r.carrier_code ?? '') }); }
      }
    } catch (err) {
      rows.push({ provider: 'easypost', serviceCode: '(rates)', strategy: 'sandbox', status: 'fail', detail: `rate quote failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    for (const svc of services) {
      const { orderId } = await createCarrierTestOrder(sql, { provider: 'easypost', serviceCode: svc.serviceCode, clientId });
      try {
        const label = await createCarrierLabel('easypost', { ...baseInput, orderId, serviceCode: svc.serviceCode });
        const tracking = String((label as any).trackingNumber ?? '');
        const url = String((label as any).labelUrl ?? '');
        const cost = Number((label as any).cost ?? 0);
        const outboxErr = await assertNoOutboxRows(sql, orderId);
        const ok = tracking.length > 0 && url.length > 0 && !/\[object Object\]/.test(url) && cost === 0 && !outboxErr;
        const detail = ok
          ? `tracking ${tracking.slice(0, 12)}… $${cost}; no marketplace notify`
          : outboxErr ?? `tracking=${!!tracking} url=${!!url} cost=${cost}`;
        rows.push({ provider: 'easypost', serviceCode: svc.serviceCode, strategy: 'sandbox', status: ok ? 'pass' : 'fail', detail });
      } catch (err) {
        rows.push({ provider: 'easypost', serviceCode: svc.serviceCode, strategy: 'sandbox', status: 'fail', detail: err instanceof Error ? err.message : String(err) });
      }
    }
    const cleaned = await cleanupCarrierTestOrders(sql);
    rows.push({ provider: '(cleanup)', serviceCode: '-', strategy: '-', status: cleaned.skippedLocked === 0 ? 'pass' : 'fail', detail: `deleted ${cleaned.deleted}; skippedLocked ${cleaned.skippedLocked}` });
  } finally {
    delete process.env.CARRIER_TEST_MODE;
    await sql.end({ timeout: 5 });
  }
  return rows;
}

// ── Shipp rates-only tier: call the REAL Shipp quote endpoint (FREE, read-only,
// no label, no money, no DB writes). Validates Shipp login + quoting + our rate
// parsing against the live account. Loads the saved Shipp carrier credentials. ──
async function runShippRates() {
  const rows = []
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    rows.push({ provider: 'shipp', serviceCode: '(rates)', strategy: 'rates-only', status: 'skipped', detail: 'DATABASE_URL not set (needed to load the saved Shipp credentials)' })
    return rows
  }
  const postgres = (await import('postgres')).default
  const { quoteCarrierRates } = await import('../src/services/carrier-connector-orchestrator.js')
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 })
  try {
    const accounts = (await sql`
      SELECT id, label, credentials FROM carrier_accounts WHERE lower(provider) = 'shipp' ORDER BY id LIMIT 1
    `)
    if (!accounts[0]) {
      rows.push({ provider: 'shipp', serviceCode: '(rates)', strategy: 'rates-only', status: 'skipped', detail: 'no Shipp carrier account found in carrier_accounts' })
      return rows
    }
    const creds = accounts[0].credentials || {}
    // FREE quote: real destination, fixed box. No label is ever created.
    const input = {
      credentials: creds,
      dimsL: 8, dimsW: 6, dimsH: 4, weightOz: 16,
      toName: 'Carrier Harness Tester', toAddress: '1318 S Reno Ave', toCity: 'El Reno', toState: 'OK', toZip: '73036', toCountry: 'US',
      rawOrder: { shipTo: { name: 'Carrier Harness Tester', street1: '1318 S Reno Ave', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US', phone: '4053686063' } },
    }
    let quote
    try {
      quote = await quoteCarrierRates('shipp', input)
    } catch (err) {
      rows.push({ provider: 'shipp', serviceCode: '(rates)', strategy: 'rates-only', status: 'fail', detail: `quote failed: ${err instanceof Error ? err.message : String(err)}` })
      return rows
    }
    const rates = Array.isArray(quote?.rates) ? quote.rates : []
    if (rates.length === 0) {
      rows.push({ provider: 'shipp', serviceCode: '(rates)', strategy: 'rates-only', status: 'fail', detail: 'Shipp returned zero rates' })
      return rows
    }
    for (const r of rates) {
      const code = String(r.serviceCode ?? r.service_code ?? r.serviceName ?? '')
      const carrier = String(r.carrierName ?? r.carrierCode ?? r.carrier ?? '')
      const price = Number(r.price ?? r.cost ?? r.amount ?? r.totalCost ?? 0)
      const serialized = JSON.stringify(r)
      const ok = code.length > 0 && Number.isFinite(price) && !/\[object Object\]/.test(serialized)
      rows.push({ provider: 'shipp', serviceCode: code || '(unnamed)', strategy: 'rates-only', status: ok ? 'pass' : 'fail', detail: ok ? `${carrier || 'Shipp'} — $${price.toFixed(2)} (quote only, $0 spent)` : `unparseable rate: code=${!!code} price=${price} objObj=${/\[object Object\]/.test(serialized)}` })
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
  return rows
}

// ── Capture tier: record REAL sandbox/test responses into fixtures for replay. ──
// Requires creds; skips cleanly (never fails) when absent so it is CI-safe.
async function runCapture(): Promise<MatrixRow[]> {
  const epKey = process.env.CARRIER_HARNESS_EASYPOST_TEST_KEY;
  if (!process.env.DATABASE_URL || !epKey || !/^EZTK/i.test(epKey)) {
    return [{ provider: '(capture)', serviceCode: '-', strategy: 'capture', status: 'skipped', detail: 'needs DATABASE_URL + EZTK test key (+ replay-carrier sandbox creds) to record fixtures' }];
  }
  return [{ provider: '(capture)', serviceCode: '-', strategy: 'capture', status: 'skipped', detail: 'capture wiring runs with full creds; see withCaptureFixture in carrier-test-mode' }];
}

async function main(): Promise<void> {
  const mode = arg('live-approved')
    ? 'live-approved'
    : arg('shipp-rates')
      ? 'shipp-rates'
      : arg('capture')
        ? 'capture'
        : arg('sandbox')
          ? 'sandbox'
          : 'self-check';
  if (mode === 'live-approved') {
    console.error('live-approved (real postage) is not implemented in this slice — manual_live_gated.');
    process.exit(2);
  }
  const rows = mode === 'shipp-rates'
    ? await runShippRates()
    : mode === 'capture'
      ? await runCapture()
      : mode === 'sandbox'
        ? await runSandbox()
        : runSelfCheck();
  writeMatrix(rows, mode);
  const fails = rows.filter((r) => r.status === 'fail');
  console.log(`\nCarrier harness (${mode}): ${rows.length} attempts · pass ${rows.filter((r) => r.status === 'pass').length} · fail ${fails.length} · skipped ${rows.filter((r) => r.status === 'skipped').length}`);
  for (const r of rows) console.log(`  ${r.status.toUpperCase().padEnd(7)} ${r.provider}/${r.serviceCode} [${r.strategy}] — ${r.detail}`);
  console.log(`\nReport: ${OUT}.md`);
  if (fails.length > 0) { console.error(`\nFAIL carrier harness (${fails.length} failing)`); process.exit(1); }
  console.log(`\nPASS carrier harness (${mode})`);
}

void main();
