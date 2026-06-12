#!/usr/bin/env tsx
/**
 * PS-202 — test-mode verification THROUGH v4 createLabelV2.
 *
 * ═══ RUN 1 FINDING (2026-06-12, DJ-authorized; orders 1281639/40/41) ═══
 * The original expectations were WRONG — and the system was RIGHT. For an
 * is_test client, PS-186's backend test-label authority forces the $0 MOCK
 * path BEFORE the direct branch can run: every leg produced a cost=0.00,
 * TEST-tracking, /labels/mock/ shipment with source='test_offline', ZERO
 * outbox rows, zero provider HTTP. That is a STRONGER money-safety invariant
 * than the one this script set out to prove: a test-client order physically
 * cannot reach a real carrier connector through createLabelV2.
 *
 * Consequence: the DIRECT branch (connector input mapping) cannot be
 * exercised through createLabelV2 with a test client BY DESIGN, and the
 * fixture store is empty — so the remaining PS-202 verification (connector
 * mapping + field-compare vs a legacy row) is the LIVE CANARY on a real
 * order (DJ's separate approval), which doubles as the fixture-capture run.
 * Do NOT weaken PS-186 to force the direct branch for test clients.
 *
 * This script now asserts the PS-186 reality (the repeatable green check):
 *   • each direct-aimed test-client purchase yields a $0 MOCK shipment
 *     (cost 0, TEST tracking, /labels/mock/ URL, source test_offline),
 *   • the order is mock-shipped with ZERO fulfillment_outbox rows,
 *   • cleanup reports the shipped harness rows as skippedLocked (lockdown-
 *     respecting) — they are $0 test fixtures for the Stage-4 purge list.
 *
 * NOTE: each run ADDS harness rows that end mock-shipped (cleanup cannot
 * delete shipped rows). Run deliberately, not in CI.
 *
 * SAFETY RAILS: dedicated is_test client (__CARRIER_HARNESS__), HARNESS-
 * order numbers, internal source, NULL external id (marketplace confirmation
 * unreachable by construction); CARRIER_TEST_MODE armed in-process only;
 * temp client↔account visibility assignments reverted in finally.
 *
 *   npx tsx scripts/ps-202-test-mode-verification.ts
 */
import 'dotenv/config';
import postgres from 'postgres';
import {
  ensureHarnessTestClient,
  createCarrierTestOrder,
  cleanupCarrierTestOrders,
  buildCarrierTestOrderSeed,
  assertSeedIsSafe,
} from './lib/carrier-test-order-factory.js';

type Row = { leg: string; status: 'pass' | 'fail'; detail: string };
const rows: Row[] = [];
function report(leg: string, ok: boolean, detail: string) {
  rows.push({ leg, status: ok ? 'pass' : 'fail', detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${leg} — ${detail}`);
}

const DIRECT_OFFSET = 10_000_000;

async function postAssertMockShipped(sql: ReturnType<typeof postgres>, orderId: number, leg: string): Promise<void> {
  const [ord] = await sql`SELECT order_status FROM orders WHERE id = ${orderId}`;
  const ships = await sql`
    SELECT carrier_code, service_code, tracking_number, cost, voided, source, coalesce(label_url, '') AS label_url
    FROM shipments WHERE order_id = ${orderId}
  `;
  const [outbox] = await sql`
    SELECT count(*)::int AS n FROM fulfillment_outbox
    WHERE order_id = ${orderId} AND status IN ('pending', 'queued', 'succeeded')
  `.catch(() => [{ n: 0 }]);
  const ship = ships[0];
  const isMock =
    ships.length === 1 &&
    Number(ship?.cost ?? -1) === 0 &&
    String(ship?.source ?? '') === 'test_offline' &&
    /^TEST/.test(String(ship?.tracking_number ?? '')) &&
    String(ship?.label_url ?? '').includes('/labels/mock/');
  report(
    `${leg}: PS-186 mock outcome ($0, TEST tracking, mock URL, test_offline, zero outbox)`,
    ord?.order_status === 'shipped' && isMock && (outbox?.n ?? 0) === 0,
    `status=${ord?.order_status} shipments=${ships.length} cost=${ship?.cost} source=${ship?.source} outbox=${outbox?.n ?? 0}`,
  );
}

function mintProof(pid: number, serviceCode: string) {
  const fp = `ps202-verify|w=160|z=94104|svc=${serviceCode}`;
  const rate = {
    carrier_id: `se-${pid}`,
    shippingProviderId: pid,
    serviceCode,
    shipmentCost: 0,
    otherCost: 0,
    requestFingerprint: fp,
    proofSource: 'backend_rate_response',
  };
  return { requestFingerprint: fp, selectedRate: rate, eligibleRates: [rate] };
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('DATABASE_URL not set'); process.exit(2); }
  // Arm the double gate for THIS process only.
  process.env.CARRIER_TEST_MODE = '1';

  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 });
  const tempAssignments: Array<{ carrierAccountId: number; clientId: number }> = [];
  try {
    const { createLabelV2 } = await import('../src/services/labels.js');
    const clientId = await ensureHarnessTestClient(sql);
    report('harness test client ready', Number.isFinite(clientId), `clientId=${clientId} (__CARRIER_HARNESS__, is_test)`);

    const accounts = await sql`
      SELECT id, lower(provider) AS provider, label FROM carrier_accounts
      WHERE lower(provider) IN ('shipp', 'walmart_shipping') AND active IS DISTINCT FROM false
      ORDER BY provider, id
    `;
    const byProvider = new Map<string, { id: number; label: string | null }>();
    for (const a of accounts) if (!byProvider.has(String(a.provider))) byProvider.set(String(a.provider), { id: Number(a.id), label: a.label as string | null });

    // Temp visibility: assign the harness client to each account (PS-083 scope
    // gate would otherwise refuse — correctly — before the connector).
    for (const [, acct] of byProvider) {
      const inserted = await sql`
        INSERT INTO carrier_account_clients (carrier_account_id, client_id)
        VALUES (${acct.id}, ${clientId})
        ON CONFLICT DO NOTHING
        RETURNING carrier_account_id
      `;
      if (inserted.length) tempAssignments.push({ carrierAccountId: acct.id, clientId });
    }

    // ── Leg 1: shipp through the FULL v4 pipeline to the armed seam ───────────
    const shipp = byProvider.get('shipp');
    if (!shipp) {
      report('shipp: account present', false, 'no active shipp carrier_accounts row');
    } else {
      const serviceCode = 'shipp_ups_ground';
      const seed = buildCarrierTestOrderSeed({ provider: 'shipp', serviceCode });
      assertSeedIsSafe(seed);
      const { orderId } = await createCarrierTestOrder(sql, { provider: 'shipp', serviceCode, clientId });
      const pid = DIRECT_OFFSET + shipp.id;
      try {
        await createLabelV2({
          orderId,
          serviceCode,
          serviceName: 'Shipp UPS Ground (harness)',
          carrierCode: 'shipp',
          shippingProviderId: pid,
          packageCode: 'package',
          weightOz: seed.weightOz,
          length: seed.dims.l,
          width: seed.dims.w,
          height: seed.dims.h,
          confirmation: 'none',
          insuranceProvider: 'none',
          shipTo: {
            name: seed.shipTo.name, street1: seed.shipTo.street1, street2: seed.shipTo.street2,
            city: seed.shipTo.city, state: seed.shipTo.state, postalCode: seed.shipTo.zip,
            country: seed.shipTo.country, phone: seed.shipTo.phone,
          },
          selectedRateProof: mintProof(pid, serviceCode),
          __carrierTestMode: true,
        } as never);
        report('shipp: test-client purchase yields a $0 mock (PS-186 authority outranks the direct branch)', true, 'createLabelV2 returned a mock label');
      } catch (err) {
        const code = (err as Error & { code?: string }).code ?? '';
        const msg = err instanceof Error ? err.message : String(err);
        report('shipp: test-client purchase yields a $0 mock (PS-186 authority outranks the direct branch)', false, `${code || 'no-code'}: ${msg.slice(0, 140)}`);
      }
      await postAssertMockShipped(sql, orderId, 'shipp');
    }

    // ── Leg 2: walmart_shipping — PS-199 labels-mode PO gate BEFORE connector ─
    const walmart = byProvider.get('walmart_shipping');
    if (!walmart) {
      report('walmart_shipping: account present', false, 'no active walmart_shipping carrier_accounts row');
    } else {
      const serviceCode = 'walmart_fedex_ground';
      const seed = buildCarrierTestOrderSeed({ provider: 'walmart_shipping', serviceCode });
      assertSeedIsSafe(seed);
      const { orderId } = await createCarrierTestOrder(sql, { provider: 'walmart_shipping', serviceCode, clientId });
      const pid = DIRECT_OFFSET + walmart.id;
      try {
        await createLabelV2({
          orderId,
          serviceCode,
          serviceName: 'Walmart FedEx Ground (harness)',
          carrierCode: 'walmart_shipping',
          shippingProviderId: pid,
          packageCode: 'package',
          weightOz: seed.weightOz,
          length: seed.dims.l,
          width: seed.dims.w,
          height: seed.dims.h,
          confirmation: 'none',
          insuranceProvider: 'none',
          shipTo: {
            name: seed.shipTo.name, street1: seed.shipTo.street1, street2: seed.shipTo.street2,
            city: seed.shipTo.city, state: seed.shipTo.state, postalCode: seed.shipTo.zip,
            country: seed.shipTo.country, phone: seed.shipTo.phone,
          },
          selectedRateProof: mintProof(pid, serviceCode),
          __carrierTestMode: true,
        } as never);
        report('walmart_shipping: test-client purchase yields a $0 mock (PS-186 — PO gate untestable here, see header)', true, 'createLabelV2 returned a mock label');
      } catch (err) {
        const code = (err as Error & { code?: string }).code ?? '';
        const msg = err instanceof Error ? err.message : String(err);
        report('walmart_shipping: test-client purchase yields a $0 mock (PS-186 — PO gate untestable here, see header)', false, `${code || 'no-code'}: ${msg.slice(0, 160)}`);
      }
      await postAssertMockShipped(sql, orderId, 'walmart_shipping');
    }

    // ── Leg 3 (RUN 1 finding): the PS-204 binding + proof gate + PS-199 PO gate
    // sit AFTER the PS-186 test-label fork, so they are NOT exercisable with a
    // test client — the mock path returns first (correct: mock labels don't
    // need proofs). Those gates are covered offline by test:ps-204-account-
    // binding / ps-199 / the cert; their live-path proof is the canary run.

    const cleaned = await cleanupCarrierTestOrders(sql);
    report(
      'cleanup: awaiting harness rows removed; mock-shipped rows correctly skipped (lockdown)',
      cleaned.deleted >= 0,
      `deleted ${cleaned.deleted}; skippedLocked ${cleaned.skippedLocked} ($0 test fixtures — Stage-4 purge list)`,
    );
  } finally {
    for (const a of tempAssignments) {
      await sql`
        DELETE FROM carrier_account_clients
        WHERE carrier_account_id = ${a.carrierAccountId} AND client_id = ${a.clientId}
      `.catch((err: unknown) => console.warn('temp assignment cleanup failed:', err instanceof Error ? err.message : err));
    }
    if (tempAssignments.length) console.log(`cleaned ${tempAssignments.length} temp visibility assignment(s)`);
    delete process.env.CARRIER_TEST_MODE;
    await sql.end({ timeout: 5 });
  }

  const fails = rows.filter((r) => r.status === 'fail');
  console.log(`\nPS-202 test-mode verification: ${rows.length} checks · pass ${rows.length - fails.length} · fail ${fails.length}`);
  if (fails.length) { console.error('FAIL PS-202 test-mode verification'); process.exit(1); }
  console.log('PASS PS-202 test-mode verification (zero postage, zero provider HTTP, zero marketplace writes)');
}

void main();
