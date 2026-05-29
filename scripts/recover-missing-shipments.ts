import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/client';
import { orders } from '../src/db/schema/orders';
import { shipments } from '../src/db/schema/shipments';
import { clients } from '../src/db/schema/clients';
import { listShipStationShipments } from '../src/connectors/store/shipstation';
import { syncShipments } from '../src/services/shipment-sync';
import { formatShipStationV1DateParam } from '../src/lib/shipstation/v1-date';
import { getSettingNumber, setSetting } from '../src/services/settings';

/**
 * PS-036 #2 — Missed-shipment recovery / backfill.
 *
 * Read-only by default. Pulls ShipStation v1 /shipments for the recovery
 * window and compares them against the local `shipments` table to report:
 *   - ShipStation shipments found
 *   - local rows already present
 *   - missing rows (SS shipment with a matching local order but no shipment row)
 *   - orders that would gain Carrier / Shipping Account / Selected Rate
 *   - unmatched orphans (SS shipment whose order isn't in our DB)
 *
 * This is the same data whose absence makes a shipped row render the honest
 * "Missing shipment sync" state in OrdersView (instead of a false "Ext. Label").
 *
 * SAFETY:
 *   - Dry-run unless `--apply` is passed.
 *   - `--apply` delegates to the canonical syncShipments() service so every
 *     existing v2-parity guard and shipped/cancelled lockdown still applies —
 *     this script never issues its own UPDATE/DELETE against shipped data.
 *   - No labels/postage are purchased and no marketplace notifications are sent.
 *   - main() only runs when invoked directly, so importing this module in a
 *     test never triggers a network fetch or a write.
 */

const LAST_SYNC_KEY = 'shipment_sync.last_created_ms';
const RECOVERY_STATUS_KEY = 'shipment_recovery.last_run';
const DEFAULT_LOOKBACK_DAYS = 14;

type SSShipment = {
  shipmentId: number;
  orderId: number;
  orderNumber?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  trackingNumber?: string | null;
  voided?: boolean | null;
  isReturnLabel?: boolean | null;
};

type SSShipmentsList = {
  shipments: SSShipment[];
  total: number;
  page: number;
  pages: number;
};

type RecoveryAccount = {
  label: string;
  apiKey: string | undefined;
  apiSecret: string | undefined;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parsePositiveInteger(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return Math.floor(value);
}

function resolveSinceMs(): number {
  const raw = argValue('date-from');
  if (raw) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new Error('--date-from must be a parseable date');
    return parsed.getTime();
  }
  const days = parsePositiveInteger('days', DEFAULT_LOOKBACK_DAYS);
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

async function loadRecoveryAccounts(): Promise<RecoveryAccount[]> {
  // Mirror loadShipmentSyncAccounts: the main account leaves credentials
  // undefined so the connector falls back to the env ShipStation key.
  const accounts: RecoveryAccount[] = [
    { label: 'main', apiKey: undefined, apiSecret: undefined },
  ];
  const rows = await db
    .select({
      name: clients.name,
      ssApiKey: clients.ssApiKey,
      ssApiSecret: clients.ssApiSecret,
    })
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
  account: RecoveryAccount,
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
      dedupeKey: `recovery:shipments:${account.label}:${sinceParam}:${page}:${pageSize}`,
    });
    all.push(...(res.shipments ?? []));
    if (!res.shipments?.length || page >= res.pages) break;
    page += 1;
    await new Promise((r) => setTimeout(r, 500));
  }
  return all;
}

type RecoveryReport = {
  ssShipmentsFound: number;
  localRowsPresent: number;
  missingRows: number;
  ordersWouldGainEnrichment: number;
  unmatchedOrphans: number;
  sampleMissing: Array<{
    shipmentId: number;
    orderId: number;
    orderNumber: string | null;
    carrierCode: string | null;
    serviceCode: string | null;
  }>;
  sampleOrphans: Array<{ shipmentId: number; orderId: number; orderNumber: string | null }>;
};

async function buildReport(ssShipments: SSShipment[]): Promise<RecoveryReport> {
  const externalIds = [...new Set(ssShipments.map((s) => String(s.orderId)))];
  const labelIds = [...new Set(ssShipments.map((s) => s.shipmentId))];

  const orderRows = externalIds.length
    ? await db
        .select({ id: orders.id, externalOrderId: orders.externalOrderId })
        .from(orders)
        .where(inArray(orders.externalOrderId, externalIds))
    : [];
  const orderByExt = new Map<string, number>();
  for (const o of orderRows) if (o.externalOrderId) orderByExt.set(o.externalOrderId, o.id);

  const existingRows = labelIds.length
    ? await db
        .select({
          labelShipmentId: shipments.labelShipmentId,
          carrierCode: shipments.carrierCode,
          serviceCode: shipments.serviceCode,
          providerAccountId: shipments.providerAccountId,
        })
        .from(shipments)
        .where(inArray(shipments.labelShipmentId, labelIds))
    : [];
  const existingByLabel = new Map<
    number,
    { carrierCode: string | null; serviceCode: string | null; providerAccountId: number | null }
  >();
  for (const r of existingRows) {
    if (r.labelShipmentId !== null) {
      existingByLabel.set(r.labelShipmentId, {
        carrierCode: r.carrierCode ?? null,
        serviceCode: r.serviceCode ?? null,
        providerAccountId: r.providerAccountId ?? null,
      });
    }
  }

  const report: RecoveryReport = {
    ssShipmentsFound: ssShipments.length,
    localRowsPresent: 0,
    missingRows: 0,
    ordersWouldGainEnrichment: 0,
    unmatchedOrphans: 0,
    sampleMissing: [],
    sampleOrphans: [],
  };
  const ordersGaining = new Set<number>();

  for (const s of ssShipments) {
    const matchedOrderId = orderByExt.get(String(s.orderId));
    const existing = existingByLabel.get(s.shipmentId);

    if (existing) {
      report.localRowsPresent += 1;
      // Local row present but lacking carrier/service/provider that SS supplies.
      const wouldEnrich =
        (!existing.carrierCode && Boolean(s.carrierCode)) ||
        (!existing.serviceCode && Boolean(s.serviceCode)) ||
        existing.providerAccountId == null;
      if (matchedOrderId != null && wouldEnrich) ordersGaining.add(matchedOrderId);
      continue;
    }

    if (matchedOrderId != null) {
      report.missingRows += 1;
      ordersGaining.add(matchedOrderId);
      if (report.sampleMissing.length < 25) {
        report.sampleMissing.push({
          shipmentId: s.shipmentId,
          orderId: s.orderId,
          orderNumber: s.orderNumber ?? null,
          carrierCode: s.carrierCode ?? null,
          serviceCode: s.serviceCode ?? null,
        });
      }
    } else {
      report.unmatchedOrphans += 1;
      if (report.sampleOrphans.length < 25) {
        report.sampleOrphans.push({
          shipmentId: s.shipmentId,
          orderId: s.orderId,
          orderNumber: s.orderNumber ?? null,
        });
      }
    }
  }

  report.ordersWouldGainEnrichment = ordersGaining.size;
  return report;
}

function printUsage(): void {
  console.log(`
PS-036 missed-shipment recovery / backfill

Usage:
  npm run shipstation:recover:dry-run
  npm run shipstation:recover:dry-run -- --days 30
  npm run shipstation:recover:apply        # explicit write — delegates to syncShipments()

Options:
  --days <n>        Recovery lookback window in days. Default: ${DEFAULT_LOOKBACK_DAYS}.
  --date-from <d>   Explicit start date (overrides --days).
  --page-size <n>   ShipStation page size. Default: 500.
  --apply           Run the real backfill via the canonical syncShipments() service.

Safety:
  Dry run only unless --apply is present.
  --apply reuses syncShipments(), preserving every v2-parity guard and the
  shipped/cancelled lockdown. This script issues no direct writes to shipped data,
  buys no labels/postage, and sends no marketplace notifications.
`);
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    printUsage();
    return;
  }

  const apply = hasFlag('apply');
  const pageSize = parsePositiveInteger('page-size', 500);
  const sinceMs = resolveSinceMs();
  const sinceParam = formatShipStationV1DateParam(sinceMs);

  console.log(`\n[shipment-recovery] ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`recoveryWindowSince=${new Date(sinceMs).toISOString()} (v1 param "${sinceParam}")`);

  const accounts = await loadRecoveryAccounts();
  const allShipments: SSShipment[] = [];
  for (const account of accounts) {
    try {
      const rows = await fetchShipmentsForAccount(account, sinceParam, pageSize);
      allShipments.push(...rows);
      console.log(`[shipment-recovery] ${account.label}: fetched ${rows.length} ShipStation shipment(s)`);
    } catch (err) {
      console.warn(
        `[shipment-recovery] ${account.label}: fetch failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const report = await buildReport(allShipments);

  console.log('\n[shipment-recovery] summary');
  console.table([
    {
      ssShipmentsFound: report.ssShipmentsFound,
      localRowsPresent: report.localRowsPresent,
      missingRows: report.missingRows,
      ordersWouldGainEnrichment: report.ordersWouldGainEnrichment,
      unmatchedOrphans: report.unmatchedOrphans,
    },
  ]);

  if (report.sampleMissing.length) {
    console.log('\nMissing shipment rows (sample, would be inserted on --apply):');
    console.table(report.sampleMissing);
  }
  if (report.sampleOrphans.length) {
    console.log('\nUnmatched orphans (ShipStation shipment, no local order — needs order sync first):');
    console.table(report.sampleOrphans);
  }

  const previousWatermark = await getSettingNumber(LAST_SYNC_KEY);

  if (apply) {
    console.log('\n[shipment-recovery] applying via syncShipments() — guards and lockdown enforced...');
    const result = await syncShipments({ sinceMs, pageSize });
    console.log(
      `[shipment-recovery] applied: fetched=${result.fetched} inserted=${result.inserted} ` +
        `updated=${result.updated} matchedOrders=${result.matchedOrders} ` +
        `orphaned=${result.orphaned} ordersMarkedShipped=${result.ordersMarkedShipped}`,
    );
  } else {
    console.log('\nDry run only. Re-run with --apply (or npm run shipstation:recover:apply) after review.');
  }

  try {
    await setSetting(
      RECOVERY_STATUS_KEY,
      JSON.stringify({
        version: 1,
        mode: apply ? 'apply' : 'dry-run',
        ranAt: new Date().toISOString(),
        sinceMs,
        sinceIso: new Date(sinceMs).toISOString(),
        previousWatermark,
        ...report,
        sampleMissing: undefined,
        sampleOrphans: undefined,
      }),
    );
  } catch (err) {
    console.warn(
      '[shipment-recovery] failed to persist recovery status:',
      err instanceof Error ? err.message : err,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
