import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/client';
import { orders } from '../src/db/schema/orders';
import { shipments } from '../src/db/schema/shipments';
import { clients } from '../src/db/schema/clients';
import { listShipStationShipments } from '../src/connectors/store/shipstation';
import { formatShipStationV1DateParam } from '../src/lib/shipstation/v1-date';

/**
 * PS-036 diagnostic — explain why `shipstation:recover:apply` inserted 0 rows
 * while the dry-run reported N "missing" rows.
 *
 * READ-ONLY. Issues no writes. Re-fetches the same ShipStation window the
 * recovery script uses, isolates the shipments the dry-run would label
 * "missing" (matched order, no local row with this labelShipmentId), and for
 * each matched order prints the ground-truth that the apply path (syncShipments
 * → upsertShipmentsBatch) actually gates on:
 *   - is the order's client a test client?  (skip at shipment-sync.ts:234)
 *   - does the order already have a non-voided PrepShip-sourced shipment?
 *     (v2-parity guard at shipment-sync.ts:241 — skips the duplicate insert)
 *   - otherwise the apply path SHOULD insert it (genuinely missing)
 *
 * This distinguishes "the dry-run over-reports" from "a real insert bug".
 */

const DEFAULT_LOOKBACK_DAYS = 14;
const PREPSHIP_SOURCES = ['prepship', 'prepship_v2', 'test_offline'] as const;

type SSShipment = {
  shipmentId: number;
  orderId: number;
  orderNumber?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  voided?: boolean | null;
  isReturnLabel?: boolean | null;
};

type SSShipmentsList = { shipments: SSShipment[]; total: number; page: number; pages: number };
type DiagAccount = { label: string; apiKey: string | undefined; apiSecret: string | undefined };

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function resolveSinceMs(): number {
  const raw = argValue('date-from');
  if (raw) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new Error('--date-from must be a parseable date');
    return parsed.getTime();
  }
  const days = Number(argValue('days') ?? DEFAULT_LOOKBACK_DAYS);
  return Date.now() - (Number.isFinite(days) && days > 0 ? days : DEFAULT_LOOKBACK_DAYS) * 86400000;
}

async function loadAccounts(): Promise<DiagAccount[]> {
  const accounts: DiagAccount[] = [{ label: 'main', apiKey: undefined, apiSecret: undefined }];
  const rows = await db
    .select({ name: clients.name, ssApiKey: clients.ssApiKey, ssApiSecret: clients.ssApiSecret })
    .from(clients)
    .where(eq(clients.active, true));
  for (const r of rows) {
    if (r.ssApiKey && r.ssApiSecret) {
      accounts.push({ label: `client:${r.name}`, apiKey: r.ssApiKey, apiSecret: r.ssApiSecret });
    }
  }
  return accounts;
}

async function fetchShipmentsForAccount(
  account: DiagAccount,
  sinceParam: string,
  pageSize: number,
): Promise<SSShipment[]> {
  const all: SSShipment[] = [];
  let page = 1;
  while (true) {
    const q = new URLSearchParams({
      createDateStart: sinceParam,
      pageSize: String(pageSize),
      page: String(page),
      sortBy: 'CreateDate',
      sortDir: 'ASC',
    });
    const res = await listShipStationShipments<SSShipmentsList>(q, {
      apiKey: account.apiKey,
      apiSecret: account.apiSecret,
      dedupeKey: `diagnose:shipments:${account.label}:${sinceParam}:${page}:${pageSize}`,
    });
    all.push(...(res.shipments ?? []));
    if (!res.shipments?.length || page >= res.pages) break;
    page += 1;
    await new Promise((r) => setTimeout(r, 500));
  }
  return all;
}

async function main(): Promise<void> {
  const pageSize = Number(argValue('page-size') ?? 500);
  const sinceMs = resolveSinceMs();
  const sinceParam = formatShipStationV1DateParam(sinceMs);

  console.log('\n[diagnose-missing] READ-ONLY — no writes are issued.');
  console.log(`recoveryWindowSince=${new Date(sinceMs).toISOString()} (v1 param "${sinceParam}")`);

  const accounts = await loadAccounts();
  const ssShipments: SSShipment[] = [];
  for (const account of accounts) {
    try {
      const rows = await fetchShipmentsForAccount(account, sinceParam, pageSize);
      ssShipments.push(...rows);
      console.log(`[diagnose-missing] ${account.label}: fetched ${rows.length} ShipStation shipment(s)`);
    } catch (err) {
      console.warn(`[diagnose-missing] ${account.label}: fetch failed:`, err instanceof Error ? err.message : err);
    }
  }

  const externalIds = [...new Set(ssShipments.map((s) => String(s.orderId)))];
  const labelIds = [...new Set(ssShipments.map((s) => s.shipmentId))];

  // Match key parity with buildReport / upsertShipmentsBatch.
  const orderRows = externalIds.length
    ? await db
        .select({
          id: orders.id,
          externalOrderId: orders.externalOrderId,
          orderStatus: orders.orderStatus,
          clientId: orders.clientId,
        })
        .from(orders)
        .where(inArray(orders.externalOrderId, externalIds))
    : [];
  const orderByExt = new Map<string, { id: number; status: string | null; clientId: number | null }>();
  for (const o of orderRows) {
    if (o.externalOrderId) orderByExt.set(o.externalOrderId, { id: o.id, status: o.orderStatus, clientId: o.clientId });
  }

  const existingLabelSet = new Set<number>();
  if (labelIds.length) {
    const rows = await db
      .select({ labelShipmentId: shipments.labelShipmentId })
      .from(shipments)
      .where(inArray(shipments.labelShipmentId, labelIds));
    for (const r of rows) if (r.labelShipmentId !== null) existingLabelSet.add(r.labelShipmentId);
  }

  // Test-client set (shipment-sync.ts:162-169 parity).
  const clientIds = [...new Set(orderRows.map((o) => o.clientId).filter((id): id is number => id !== null))];
  const testClientSet = new Set<number>();
  if (clientIds.length) {
    const cliRows = await db
      .select({ id: clients.id, isTest: clients.isTest })
      .from(clients)
      .where(inArray(clients.id, clientIds));
    for (const c of cliRows) if (c.isTest) testClientSet.add(c.id);
  }

  // PrepShip-guard set (shipment-sync.ts:207-223 parity).
  const orderIdsForCheck = orderRows.map((o) => o.id);
  const prepshipOrderIds = new Set<number>();
  if (orderIdsForCheck.length) {
    const prepshipRows = await db
      .select({ orderId: shipments.orderId })
      .from(shipments)
      .where(
        and(
          inArray(shipments.orderId, orderIdsForCheck),
          eq(shipments.voided, false),
          inArray(shipments.source, [...PREPSHIP_SOURCES]),
        ),
      );
    for (const r of prepshipRows) if (r.orderId !== null) prepshipOrderIds.add(r.orderId);
  }

  // Isolate the SS shipments the dry-run labels "missing": matched order, no
  // local row with this labelShipmentId.
  const missingMatchedOrderIds = new Set<number>();
  for (const s of ssShipments) {
    const ord = orderByExt.get(String(s.orderId));
    if (ord && !existingLabelSet.has(s.shipmentId)) missingMatchedOrderIds.add(ord.id);
  }

  // Pull EVERY shipment row for those orders so we can show why apply skips.
  const orderShipmentRows = missingMatchedOrderIds.size
    ? await db
        .select({
          orderId: shipments.orderId,
          source: shipments.source,
          voided: shipments.voided,
          labelShipmentId: shipments.labelShipmentId,
          carrierCode: shipments.carrierCode,
          serviceCode: shipments.serviceCode,
          providerAccountId: shipments.providerAccountId,
        })
        .from(shipments)
        .where(inArray(shipments.orderId, [...missingMatchedOrderIds]))
    : [];
  const shipmentsByOrder = new Map<number, typeof orderShipmentRows>();
  for (const r of orderShipmentRows) {
    if (r.orderId === null) continue;
    const list = shipmentsByOrder.get(r.orderId) ?? [];
    list.push(r);
    shipmentsByOrder.set(r.orderId, list);
  }

  const classification: Array<Record<string, unknown>> = [];
  let testSkip = 0;
  let prepshipSkip = 0;
  let genuinelyMissing = 0;

  for (const s of ssShipments) {
    const ord = orderByExt.get(String(s.orderId));
    if (!ord || existingLabelSet.has(s.shipmentId)) continue; // not a dry-run "missing"

    let verdict: string;
    if (ord.clientId != null && testClientSet.has(ord.clientId)) {
      verdict = 'TEST_CLIENT_SKIP (orphaned by apply)';
      testSkip += 1;
    } else if (prepshipOrderIds.has(ord.id)) {
      verdict = 'PREPSHIP_GUARD_SKIP (apply inserts nothing)';
      prepshipSkip += 1;
    } else {
      verdict = 'GENUINELY_MISSING (apply SHOULD insert)';
      genuinelyMissing += 1;
    }

    const existing = shipmentsByOrder.get(ord.id) ?? [];
    classification.push({
      ssShipmentId: s.shipmentId,
      ssOrderId: s.orderId,
      orderNumber: s.orderNumber ?? null,
      localOrderId: ord.id,
      orderStatus: ord.status,
      ssVoided: Boolean(s.voided),
      existingRows: existing.length,
      existingSources: existing.map((r) => `${r.source}${r.voided ? '(voided)' : ''}`).join(',') || '—',
      verdict,
    });
  }

  console.log('\n[diagnose-missing] verdict tally for dry-run "missing" shipments');
  console.table([{ testClientSkip: testSkip, prepshipGuardSkip: prepshipSkip, genuinelyMissing }]);

  if (classification.length) {
    console.log('\n[diagnose-missing] per-shipment breakdown');
    console.table(classification);
  } else {
    console.log('\n[diagnose-missing] no dry-run "missing" shipments in this window.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
