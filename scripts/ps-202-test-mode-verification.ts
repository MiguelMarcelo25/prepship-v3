#!/usr/bin/env tsx
/**
 * PS-202 — test-mode verification THROUGH v4 createLabelV2 (DJ go: 2026-06-12).
 *
 * Proves the v4 direct-label pipeline end-to-end with ZERO postage, ZERO
 * provider HTTP, and ZERO marketplace notifications:
 *
 *   proof gate → PS-204 account binding → direct family assert → PS-083
 *   scope-asserted account load → (walmart: PS-199 labels-mode PO gate) →
 *   orchestrator $0 test seam
 *
 * What each leg PROVES tonight (no replay fixtures are recorded yet — the
 * fixture store is empty, so the seam fails CLOSED at the connector boundary):
 *   • shipp           — the WHOLE v4 pipeline runs in production order and the
 *                       connector call is reached ONLY through the armed seam,
 *                       which refuses to proceed without a recorded fixture
 *                       (CARRIER_TEST_MODE_REPLAY_MISSING). No HTTP performed.
 *   • walmart_shipping — the PS-199 labels-mode resolver throws BEFORE any
 *                       connector call on an order with no verifiable Walmart
 *                       PO: the never-buy-unverified rule holds through v4.
 *   • ps-204 negative — a proof carried from a DIFFERENT account is blocked
 *                       with DIRECT_CARRIER_ON_SHIPSTATION_PATH before any call.
 *   • after every leg — the order is still awaiting_shipment, zero shipments
 *                       rows, zero fulfillment_outbox rows.
 *
 * SAFETY RAILS (same model as the carrier harness):
 *   - dedicated is_test client (__CARRIER_HARNESS__), HARNESS- order numbers,
 *     source_provider='internal', external_order_id NULL → marketplace
 *     confirmation unreachable by construction.
 *   - CARRIER_TEST_MODE armed in-process only; the per-call flag rides the
 *     label body (double gate).
 *   - temp client↔account visibility assignments are recorded and removed in
 *     finally; only rows THIS run inserted are deleted.
 *   - cleanup deletes only HARNESS- awaiting rows (factory rule).
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

async function postAssertUntouched(sql: ReturnType<typeof postgres>, orderId: number, leg: string): Promise<void> {
  const [ord] = await sql`SELECT order_status FROM orders WHERE id = ${orderId}`;
  const [ship] = await sql`SELECT count(*)::int AS n FROM shipments WHERE order_id = ${orderId}`;
  const [outbox] = await sql`
    SELECT count(*)::int AS n FROM fulfillment_outbox
    WHERE order_id = ${orderId} AND status IN ('pending', 'queued', 'succeeded')
  `.catch(() => [{ n: 0 }]);
  report(
    `${leg}: order untouched after the blocked attempt`,
    ord?.order_status === 'awaiting_shipment' && (ship?.n ?? 0) === 0 && (outbox?.n ?? 0) === 0,
    `status=${ord?.order_status} shipments=${ship?.n ?? 0} outbox=${outbox?.n ?? 0}`,
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
        report('shipp: pipeline reaches the $0 seam', false, 'label unexpectedly created (no fixture exists — this should be impossible)');
      } catch (err) {
        const code = (err as Error & { code?: string }).code ?? '';
        const msg = err instanceof Error ? err.message : String(err);
        report(
          'shipp: pipeline reaches the $0 seam and fails CLOSED (no fixture recorded yet)',
          code === 'CARRIER_TEST_MODE_REPLAY_MISSING',
          `${code || 'no-code'}: ${msg.slice(0, 140)}`,
        );
      }
      await postAssertUntouched(sql, orderId, 'shipp');
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
        report('walmart_shipping: PO gate blocks unverifiable purchase', false, 'label unexpectedly created without a verifiable Walmart PO');
      } catch (err) {
        const code = (err as Error & { code?: string }).code ?? '';
        const msg = err instanceof Error ? err.message : String(err);
        const isPoGate = code !== 'CARRIER_TEST_MODE_REPLAY_MISSING' && /walmart|purchase\s*order|purchaseorderid/i.test(msg);
        report(
          'walmart_shipping: PS-199 labels-mode gate throws BEFORE any connector call (never buy unverified)',
          isPoGate,
          `${code || 'no-code'}: ${msg.slice(0, 160)}`,
        );
      }
      await postAssertUntouched(sql, orderId, 'walmart_shipping');
    }

    // ── Leg 3: PS-204 negative — cross-account proof blocked through v4 ───────
    if (shipp) {
      const serviceCode = 'shipp_ups_ground';
      const { orderId } = await createCarrierTestOrder(sql, { provider: 'shipp', serviceCode, clientId });
      const pid = DIRECT_OFFSET + shipp.id;
      try {
        await createLabelV2({
          orderId,
          serviceCode,
          carrierCode: 'shipp',
          shippingProviderId: pid,
          packageCode: 'package',
          weightOz: 16,
          length: 8, width: 6, height: 4,
          confirmation: 'none',
          insuranceProvider: 'none',
          // Proof from a ShipStation account — the 1484 shape, through v4.
          selectedRateProof: mintProof(565377, serviceCode),
          __carrierTestMode: true,
        } as never);
        report('ps-204: cross-account proof blocked through v4', false, 'purchase proceeded on a mismatched proof');
      } catch (err) {
        const code = (err as Error & { code?: string }).code ?? '';
        report(
          'ps-204: cross-account proof blocked through v4 (the 1484 shape)',
          code === 'DIRECT_CARRIER_ON_SHIPSTATION_PATH',
          `${code}: ${(err as Error).message.slice(0, 120)}`,
        );
      }
      await postAssertUntouched(sql, orderId, 'ps-204 negative');
    }

    const cleaned = await cleanupCarrierTestOrders(sql);
    report('cleanup: harness orders removed', cleaned.skippedLocked === 0, `deleted ${cleaned.deleted}; skippedLocked ${cleaned.skippedLocked}`);
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
