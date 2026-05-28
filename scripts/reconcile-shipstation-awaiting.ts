import 'dotenv/config';
import postgres from 'postgres';
import {
  type MarketplaceProvider,
  aggregateMarketplaceOrderStatus,
} from '../api/_lib/marketplace-status-reconciliation.ts';
import {
  type PrepShipOrderStatus,
  type ShipStationAwaitingKey,
  type ShipStationParityLocalOrder,
  classifyShipStationAwaitingParity,
  shouldApplyShipStationAwaitingParityCandidate,
  shouldApplyShipStationAwaitingParityOverrideCandidate,
} from '../api/_lib/shipstation-awaiting-parity.ts';
import { listShipStationOrders } from '../src/connectors/store/shipstation.ts';

type Sql = ReturnType<typeof postgres>;

type SyncAccount = {
  label: string;
  apiKey?: string;
  apiSecret?: string;
  storeIds: number[];
};

type SSOrder = {
  orderId?: number | string | null;
  orderNumber?: string | null;
  orderStatus?: string | null;
  advancedOptions?: {
    storeId?: number | string | null;
  } | null;
};

type SSOrdersList = {
  orders?: SSOrder[];
  total?: number;
  page?: number;
  pages?: number;
};

type LocalRow = ShipStationParityLocalOrder & {
  clientName: string | null;
  marketplaceStatuses: string[] | null;
  marketplaceProviders: string[] | null;
};

const PARITY_STATUS_KEY = 'shipstation_awaiting_parity.last_run';

type ShipStationAwaitingParityRunStatus = {
  version: 1;
  mode: 'dry-run' | 'apply';
  ranAt: string;
  allowShippedOverride: boolean;
  storeIds: number[] | null;
  orderNumbers: string[] | null;
  dateFrom: string | null;
  pageSize: number;
  liveAwaiting: number;
  localChecked: number;
  findings: number;
  safeCandidates: number;
  blocked: number;
  needsConfirmation: number;
  shippedOverrideEligible: number;
  updatedSafe: number | null;
  updatedOverride: number | null;
  sampleFindings: Array<{
    id: number;
    orderNumber: string | null;
    externalOrderId: string | null;
    storeId: number | null;
    from: string;
    to: string | null;
    kind: string;
  }>;
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

function parseOrderNumbers(): string[] | undefined {
  const raw = argValue('order-number') ?? argValue('order-numbers');
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function parseStoreIds(): number[] | undefined {
  const raw = argValue('store-id') ?? argValue('store-ids');
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));
  return values.length ? [...new Set(values)] : undefined;
}

function parseDateFrom(): Date | null {
  if (hasFlag('all-dates')) return null;
  const raw = argValue('date-from');
  if (raw) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new Error('--date-from must be a parseable date');
    return parsed;
  }
  const days = parsePositiveInteger('days', 30);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function cleanStatus(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function statusFromMarketplace(rows: LocalRow): PrepShipOrderStatus | null {
  const providers = rows.marketplaceProviders ?? [];
  const statuses = rows.marketplaceStatuses ?? [];
  const providerSet = new Set(
    providers
      .map((provider) => String(provider ?? '').trim().toLowerCase())
      .filter((provider): provider is MarketplaceProvider => provider === 'walmart' || provider === 'ebay'),
  );
  for (const provider of providerSet) {
    const providerStatuses = statuses
      .filter((entry) => entry.toLowerCase().startsWith(`${provider}:`))
      .map((entry) => entry.slice(provider.length + 1));
    const target = aggregateMarketplaceOrderStatus(providerStatuses, provider);
    if (target && target !== 'awaiting_shipment') return target;
  }
  return null;
}

async function loadSyncAccounts(sql: Sql, requestedStoreIds?: number[]): Promise<SyncAccount[]> {
  const clientRows = await sql<Array<{
    id: number;
    name: string;
    storeIds: number[] | null;
    ssApiKey: string | null;
    ssApiSecret: string | null;
  }>>`
    SELECT id, name, store_ids AS "storeIds", ss_api_key AS "ssApiKey", ss_api_secret AS "ssApiSecret"
    FROM clients
    WHERE active = true
  `;

  const allStoreIds = [
    ...new Set(
      clientRows
        .flatMap((row) => row.storeIds ?? [])
        .filter((storeId) => Number.isFinite(storeId) && (!requestedStoreIds || requestedStoreIds.includes(storeId))),
    ),
  ];

  const accounts: SyncAccount[] = [
    {
      label: 'main',
      storeIds: allStoreIds,
    },
  ];

  for (const row of clientRows) {
    if (!row.ssApiKey || !row.ssApiSecret) continue;
    const storeIds = (row.storeIds ?? []).filter(
      (storeId) => !requestedStoreIds || requestedStoreIds.includes(storeId),
    );
    if (!storeIds.length && requestedStoreIds?.length) continue;
    accounts.push({
      label: `client:${row.name}`,
      apiKey: row.ssApiKey,
      apiSecret: row.ssApiSecret,
      storeIds,
    });
  }

  return accounts;
}

async function fetchLiveAwaitingForAccount(
  account: SyncAccount,
  options: { pageSize: number },
): Promise<ShipStationAwaitingKey[]> {
  const result: ShipStationAwaitingKey[] = [];
  const targets = account.storeIds.length > 0 ? account.storeIds : [undefined];

  for (const storeId of targets) {
    let page = 1;
    let pages = 1;
    while (page <= pages) {
      const q = new URLSearchParams({
        orderStatus: 'awaiting_shipment',
        pageSize: String(options.pageSize),
        page: String(page),
        sortBy: 'ModifyDate',
        sortDir: 'ASC',
      });
      if (storeId !== undefined) q.set('storeId', String(storeId));

      const response = await listShipStationOrders<SSOrdersList>(q, {
        apiKey: account.apiKey,
        apiSecret: account.apiSecret,
        dedupeKey: `awaiting-parity:${account.label}:${storeId ?? 'all'}:${page}:${options.pageSize}`,
      });

      pages = Math.max(1, Number(response.pages ?? 1));
      for (const order of response.orders ?? []) {
        const rawStoreId = order.advancedOptions?.storeId ?? storeId ?? null;
        result.push({
          externalOrderId: order.orderId ?? null,
          orderNumber: order.orderNumber ?? null,
          storeId: rawStoreId,
        });
      }
      page += 1;
    }
  }

  return result;
}

async function fetchLiveAwaiting(sql: Sql, options: {
  requestedStoreIds?: number[];
  pageSize: number;
}): Promise<ShipStationAwaitingKey[]> {
  const accounts = await loadSyncAccounts(sql, options.requestedStoreIds);
  const all: ShipStationAwaitingKey[] = [];
  for (const account of accounts) {
    try {
      const rows = await fetchLiveAwaitingForAccount(account, { pageSize: options.pageSize });
      all.push(...rows);
      console.log(`[shipstation-awaiting] ${account.label}: fetched ${rows.length} live awaiting row(s)`);
    } catch (err) {
      console.warn(
        `[shipstation-awaiting] ${account.label}: live awaiting fetch failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return all;
}

async function loadLocalRows(sql: Sql, options: {
  storeIds?: number[];
  orderNumbers?: string[];
  dateFrom: Date | null;
}): Promise<ShipStationParityLocalOrder[]> {
  const rows = await sql<LocalRow[]>`
    SELECT
      o.id,
      o.order_number AS "orderNumber",
      o.external_order_id AS "externalOrderId",
      o.store_id AS "storeId",
      o.order_status AS "currentStatus",
      o.raw->>'orderStatus' AS "rawStatus",
      o.externally_shipped AS "externallyShipped",
      c.name AS "clientName",
      EXTRACT(EPOCH FROM (NOW() - o.updated_at)) / 60 AS "minutesSinceTerminal",
      EXISTS (
        SELECT 1
        FROM shipments s
        WHERE (s.order_id = o.id OR (s.order_id IS NULL AND s.order_number = o.order_number))
          AND coalesce(s.voided, false) = false
          AND coalesce(s.is_return, false) = false
      ) AS "hasNonVoidedShipment",
      (
        SELECT coalesce(s.voided, false)
        FROM shipments s
        WHERE s.order_id = o.id OR (s.order_id IS NULL AND s.order_number = o.order_number)
        ORDER BY s.id DESC
        LIMIT 1
      ) AS "latestShipmentVoided",
      (
        SELECT o2.order_status
        FROM orders o2
        WHERE o2.id <> o.id
          AND o2.order_number = o.order_number
          AND o2.order_status IN ('shipped', 'cancelled')
          AND (
            o2.store_id = o.store_id
            OR (o2.store_id IS NULL AND o.store_id IS NULL)
          )
        ORDER BY o2.updated_at DESC NULLS LAST, o2.id DESC
        LIMIT 1
      ) AS "duplicateTerminalStatus",
      ARRAY(
        SELECT DISTINCT so.provider
        FROM store_orders so
        WHERE so.customer_order_id = o.order_number
          AND so.provider IN ('walmart', 'ebay')
      ) AS "marketplaceProviders",
      ARRAY(
        SELECT DISTINCT so.provider || ':' || coalesce(so.source_status, '')
        FROM store_orders so
        WHERE so.customer_order_id = o.order_number
          AND so.provider IN ('walmart', 'ebay')
      ) AS "marketplaceStatuses"
    FROM orders o
    LEFT JOIN clients c ON c.id = o.client_id
    WHERE o.order_status IN ('awaiting_shipment', 'shipped', 'cancelled')
      AND (${options.dateFrom?.toISOString() ?? null}::timestamptz IS NULL OR o.order_date >= ${options.dateFrom?.toISOString() ?? null}::timestamptz)
      AND (${options.storeIds ?? null}::int[] IS NULL OR o.store_id = ANY(${options.storeIds ?? null}::int[]))
      AND (${options.orderNumbers ?? null}::text[] IS NULL OR o.order_number = ANY(${options.orderNumbers ?? null}::text[]))
    ORDER BY o.store_id NULLS LAST, o.order_date DESC NULLS LAST, o.id DESC
  `;

  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    externalOrderId: row.externalOrderId,
    storeId: row.storeId,
    currentStatus: row.currentStatus,
    rawStatus: row.rawStatus,
    externallyShipped: row.externallyShipped,
    hasNonVoidedShipment: row.hasNonVoidedShipment,
    latestShipmentVoided: row.latestShipmentVoided,
    minutesSinceTerminal: row.minutesSinceTerminal,
    duplicateTerminalStatus: cleanStatus(row.duplicateTerminalStatus) as PrepShipOrderStatus | null,
    marketplaceTerminalStatus: statusFromMarketplace(row),
  }));
}

async function applySafeCandidates(
  sql: Sql,
  candidates: ReturnType<typeof classifyShipStationAwaitingParity>,
  options: { allowShippedOverride: boolean },
): Promise<{ safeUpdated: number; overrideUpdated: number }> {
  let safeUpdated = 0;
  let overrideUpdated = 0;
  for (const candidate of candidates) {
    if (shouldApplyShipStationAwaitingParityCandidate(candidate)) {
      const rows = await sql<Array<{ id: number }>>`
        UPDATE orders
        SET order_status = ${candidate.targetStatus}, updated_at = NOW()
        WHERE id = ${candidate.id}
          AND order_status = 'awaiting_shipment'
        RETURNING id
      `;
      safeUpdated += rows.length;
      continue;
    }

    if (
      options.allowShippedOverride &&
      shouldApplyShipStationAwaitingParityOverrideCandidate(candidate)
    ) {
      // Per user override `unlock shipped data` on 2026-05-19: allow a
      // terminal row to reopen only when ShipStation/raw awaiting evidence
      // exists and there is no active non-voided shipment.
      const rows = await sql<Array<{ id: number }>>`
        UPDATE orders
        SET order_status = 'awaiting_shipment', updated_at = NOW()
        WHERE id = ${candidate.id}
          AND order_status = ${candidate.currentStatus}
          AND order_status IN ('shipped', 'cancelled')
        RETURNING id
      `;
      overrideUpdated += rows.length;
    }
  }
  return { safeUpdated, overrideUpdated };
}

async function persistParityRunStatus(
  sql: Sql,
  status: ShipStationAwaitingParityRunStatus,
): Promise<void> {
  try {
    await sql`
      INSERT INTO settings (key, value)
      VALUES (${PARITY_STATUS_KEY}, ${JSON.stringify(status)})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `;
  } catch (err) {
    console.warn(
      '[shipstation-awaiting] failed to persist parity status:',
      err instanceof Error ? err.message : err,
    );
  }
}

function printUsage(): void {
  console.log(`
Usage:
  npm run shipstation:awaiting:diff
  npm run shipstation:awaiting:reconcile -- --store-id 376661
  npm run shipstation:awaiting:reconcile -- --order-number 200014602719051
  npm run shipstation:awaiting:reconcile:apply -- --store-id 376661

Options:
  --store-id / --store-ids      Limit to one or more ShipStation store ids.
  --order-number               Limit to one or more order numbers.
  --days                       Local order lookback window. Default: 30.
  --all-dates                  Disable local date lookback.
  --page-size                  ShipStation page size. Default: 500.
  --apply                      Apply safe awaiting -> terminal corrections.
  --allow-shipped-override     With --apply, also apply eligible terminal -> awaiting corrections.

Safety:
  Dry run only unless --apply is present.
  Only awaiting_shipment rows can be updated without the shipped-data override.
  Per user override 'unlock shipped data': --allow-shipped-override is required for shipped/cancelled -> awaiting.
  Shipped/cancelled -> awaiting findings are reported as blocked by shipped/cancelled lockdown.
`);
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    printUsage();
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');

  const apply = hasFlag('apply');
  const allowShippedOverride = hasFlag('allow-shipped-override');
  const storeIds = parseStoreIds();
  const orderNumbers = parseOrderNumbers();
  const dateFrom = parseDateFrom();
  const pageSize = parsePositiveInteger('page-size', 500);
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    const liveAwaiting = await fetchLiveAwaiting(sql, {
      requestedStoreIds: storeIds,
      pageSize,
    });
    const localRows = await loadLocalRows(sql, { storeIds, orderNumbers, dateFrom });
    const findings = classifyShipStationAwaitingParity(localRows, liveAwaiting);
    const actionable = findings.filter((finding) => finding.kind !== 'in_sync');
    const safe = actionable.filter(shouldApplyShipStationAwaitingParityCandidate);
    const overrideSafe = actionable.filter(shouldApplyShipStationAwaitingParityOverrideCandidate);
    const blocked = actionable.filter((finding) => finding.blockedByLockdown);
    const needsConfirmation = actionable.filter((finding) => finding.targetStatus === null);

    console.log(`\n[shipstation-awaiting] ${apply ? 'APPLY' : 'DRY RUN'}`);
    console.log(
      `liveAwaiting=${liveAwaiting.length} localChecked=${localRows.length} findings=${actionable.length} safeCandidates=${safe.length} blocked=${blocked.length} needsConfirmation=${needsConfirmation.length}`,
    );

    if (allowShippedOverride) {
      console.log(`shippedOverrideEligible=${overrideSafe.length}`);
    }

    if (actionable.length) {
      console.table(
        actionable.map((finding) => ({
          id: finding.id,
          orderNumber: finding.orderNumber,
          externalOrderId: finding.externalOrderId,
          storeId: finding.storeId,
          from: finding.currentStatus,
          to: finding.targetStatus ?? '-',
          kind: finding.kind,
          evidence: finding.sourceEvidence.join(', ') || '-',
          apply: shouldApplyShipStationAwaitingParityCandidate(finding)
            ? 'safe'
            : allowShippedOverride && shouldApplyShipStationAwaitingParityOverrideCandidate(finding)
              ? 'override'
              : 'no',
        })),
      );
    }

    if (blocked.length && !allowShippedOverride) {
      console.log('\nBlocked by shipped/cancelled lockdown:');
      for (const finding of blocked) {
        console.log(
          `- ${finding.orderNumber} (${finding.id}) ${finding.currentStatus} -> ${finding.targetStatus}: ${finding.reason}`,
        );
      }
    }

    if (blocked.length && allowShippedOverride) {
      console.log('\nShipped-data override enabled for eligible terminal -> awaiting corrections.');
      for (const finding of blocked) {
        const eligible = shouldApplyShipStationAwaitingParityOverrideCandidate(finding)
          ? 'eligible'
          : 'not eligible';
        console.log(
          `- ${finding.orderNumber} (${finding.id}) ${finding.currentStatus} -> ${finding.targetStatus}: ${eligible}; ${finding.reason}`,
        );
      }
    }

    if (needsConfirmation.length) {
      console.log('\nNeeds terminal confirmation before changing:');
      for (const finding of needsConfirmation) {
        console.log(`- ${finding.orderNumber} (${finding.id}): ${finding.reason}`);
      }
    }

    let updatedSafe: number | null = null;
    let updatedOverride: number | null = null;
    if (apply) {
      const { safeUpdated, overrideUpdated } = await applySafeCandidates(sql, findings, {
        allowShippedOverride,
      });
      updatedSafe = safeUpdated;
      updatedOverride = overrideUpdated;
      console.log(`\nUpdated ${safeUpdated} safe awaiting_shipment row(s).`);
      if (allowShippedOverride) {
        console.log(`Updated ${overrideUpdated} shipped-data override row(s).`);
      }
    } else {
      console.log('\nDry run only. Re-run with --apply after reviewing the candidate table.');
    }

    await persistParityRunStatus(sql, {
      version: 1,
      mode: apply ? 'apply' : 'dry-run',
      ranAt: new Date().toISOString(),
      allowShippedOverride,
      storeIds: storeIds ?? null,
      orderNumbers: orderNumbers ?? null,
      dateFrom: dateFrom?.toISOString() ?? null,
      pageSize,
      liveAwaiting: liveAwaiting.length,
      localChecked: localRows.length,
      findings: actionable.length,
      safeCandidates: safe.length,
      blocked: blocked.length,
      needsConfirmation: needsConfirmation.length,
      shippedOverrideEligible: overrideSafe.length,
      updatedSafe,
      updatedOverride,
      sampleFindings: actionable.slice(0, 25).map((finding) => ({
        id: finding.id,
        orderNumber: finding.orderNumber,
        externalOrderId: finding.externalOrderId,
        storeId: finding.storeId,
        from: finding.currentStatus,
        to: finding.targetStatus,
        kind: finding.kind,
      })),
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
