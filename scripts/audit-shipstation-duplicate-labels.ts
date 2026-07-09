import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { and, between, eq, or, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { clients } from '../src/db/schema/clients';
import { orders } from '../src/db/schema/orders';
import { shipments } from '../src/db/schema/shipments';
import {
  getShipStationAuditTracking,
  listShipStationAuditLabels,
} from '../src/lib/shipstation/duplicate-label-audit-source';
import { loadClientCredentials } from '../src/lib/shipstation/credentials';
import { csvEscape } from '../src/services/orders-csv-format';
import {
  auditShipStationDuplicateLabels,
  normalizeShipStationAuditLabel,
  type AuditDimensions,
  type DuplicateLabelAuditReport,
  type ShipStationAuditLabel,
  type ShipStationLocalLabelEvidence,
} from '../src/services/shipstation-duplicate-label-audit';

/**
 * PS-406 read-only duplicate-label audit.
 * Reads ShipStation labels/tracking plus PrepShip shipment/order evidence and writes only
 * redacted local JSON/CSV reports. It has no provider or database mutation mode.
 *
 * npm run audit:shipstation-duplicate-labels -- --start 2026-07-01 --end 2026-07-10 --client HUGRAB --dry-run
 */

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function parseDate(value: string | null, fallback: Date, endOfDay = false): Date {
  if (!value) return fallback;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function dimensions(length: number | null, width: number | null, height: number | null): AuditDimensions | null {
  return length == null && width == null && height == null ? null : { length, width, height };
}

function providerLabelId(selectedRateJson: unknown): string | null {
  if (!selectedRateJson || typeof selectedRateJson !== 'object' || Array.isArray(selectedRateJson)) return null;
  const value = (selectedRateJson as Record<string, unknown>).providerLabelId;
  return value == null ? null : String(value).trim() || null;
}

async function resolveClient(name: string) {
  const rows = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(sql`lower(${clients.name}) = lower(${name})`)
    .limit(2);
  if (rows.length !== 1 || !rows[0]) throw new Error(`Expected exactly one PrepShip client named "${name}".`);
  return rows[0];
}

async function loadLocalEvidence(
  clientId: number,
  clientName: string,
  start: Date,
  end: Date,
): Promise<ShipStationLocalLabelEvidence[]> {
  const rows = await db
    .select({
      localShipmentId: shipments.id,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      externalOrderId: orders.externalOrderId,
      sourceOrderId: orders.sourceOrderId,
      sourceOrderNumber: orders.sourceOrderNumber,
      clientId: clients.id,
      clientName: clients.name,
      selectedRateJson: shipments.selectedRateJson,
      labelShipmentId: shipments.labelShipmentId,
      trackingNumber: shipments.trackingNumber,
      carrierCode: shipments.carrierCode,
      serviceCode: shipments.serviceCode,
      weightOz: shipments.weightOz,
      dimsL: shipments.dimsL,
      dimsW: shipments.dimsW,
      dimsH: shipments.dimsH,
      shipToName: orders.shipToName,
      shipToCity: orders.shipToCity,
      shipToState: orders.shipToState,
      shipToPostalCode: orders.shipToPostalCode,
    })
    .from(shipments)
    .leftJoin(orders, eq(shipments.orderId, orders.id))
    .leftJoin(clients, eq(shipments.clientId, clients.id))
    .where(
      and(
        or(eq(shipments.clientId, clientId), eq(orders.clientId, clientId)),
        or(
          between(shipments.createdAt, start, end),
          between(shipments.labelCreatedAt, start, end),
          between(shipments.createDate, start, end),
          between(shipments.shipDate, start, end),
        ),
      ),
    );

  return rows.map((row) => ({
    localShipmentId: row.localShipmentId,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    externalOrderId: row.externalOrderId,
    sourceOrderId: row.sourceOrderId,
    sourceOrderNumber: row.sourceOrderNumber,
    clientId: row.clientId ?? clientId,
    clientName: row.clientName ?? clientName,
    providerLabelId: providerLabelId(row.selectedRateJson),
    labelShipmentId: row.labelShipmentId,
    trackingNumber: row.trackingNumber,
    carrierCode: row.carrierCode,
    serviceCode: row.serviceCode,
    weightOz: row.weightOz,
    dimensions: dimensions(row.dimsL, row.dimsW, row.dimsH),
    recipient: {
      name: row.shipToName,
      city: row.shipToCity,
      state: row.shipToState,
      postalCode: row.shipToPostalCode,
      countryCode: 'US',
    },
  }));
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]!);
    }
  }));
  return output;
}

function renderCsv(report: DuplicateLabelAuditReport): string {
  const headers = [
    'classification', 'group_key', 'action', 'label_id', 'shipment_id', 'tracking_number',
    'created_at', 'carrier_code', 'service_code', 'shipment_cost', 'insurance_cost',
    'estimated_refund_amount', 'tracking_status', 'tracking_first_event_at',
    'tracking_last_event_at', 'scanned', 'voided', 'refund_status',
    'age_days', 'within_usps_28_day_window', 'within_ups_other_30_day_window',
    'refund_assist_possible', 'manual_void_would_disqualify_refund_assist',
    'package_count', 'weight_oz', 'dimensions', 'label_download_present',
    'client_name', 'order_number', 'local_shipment_id', 'matched_by',
    'redacted_recipient', 'recipient_fingerprint',
  ];
  const rows = report.groups
    .filter((group) => group.classification !== 'NOT_DUPLICATE')
    .flatMap((group) => group.labels.map((label) => [
      group.classification,
      group.groupKey,
      label.action,
      label.labelId,
      label.shipmentId,
      label.trackingNumber,
      label.createdAt,
      label.carrierCode,
      label.serviceCode,
      label.shipmentCost,
      label.insuranceCost,
      label.estimatedRefundAmount,
      label.trackingStatusCode,
      label.trackingFirstEventAt,
      label.trackingLastEventAt,
      label.scanned,
      label.voided,
      label.refundStatus,
      label.ageDays,
      label.withinUsps28DayWindow,
      label.withinUpsOther30DayWindow,
      label.refundAssistPossible,
      label.manualVoidWouldDisqualifyRefundAssist,
      label.packageCount,
      label.totalWeightOz,
      label.dimensions ? `${label.dimensions.length ?? ''}x${label.dimensions.width ?? ''}x${label.dimensions.height ?? ''}` : '',
      label.labelDownloadPresent,
      label.clientName,
      label.orderNumber,
      label.localShipmentId,
      label.matchedBy,
      label.redactedRecipient,
      label.recipientFingerprint,
    ]));
  return [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function writeReport(report: DuplicateLabelAuditReport, outputBase: string): { json: string; csv: string } {
  const base = resolve(outputBase.replace(/\.(json|csv)$/i, ''));
  const json = `${base}.json`;
  const csv = `${base}.csv`;
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(csv, renderCsv(report), 'utf8');
  return { json, csv };
}

type Fixture = {
  labels: ShipStationAuditLabel[];
  localEvidence: ShipStationLocalLabelEvidence[];
  asOf?: string;
  start?: string;
  end?: string;
};

async function main(): Promise<void> {
  if (process.argv.some((arg) => arg === '--apply' || arg.startsWith('--apply='))) {
    throw new Error('PS-406 is read-only and has no mutation mode.');
  }
  const fixturePath = argValue('fixture');
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 7 * 86_400_000);
  const start = parseDate(argValue('start'), defaultStart);
  const end = parseDate(argValue('end'), now, true);
  if (start > end) throw new Error('--start must be before --end.');
  const duplicateWindowMinutes = Math.max(1, Number(argValue('window-minutes') ?? '60') || 60);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outputBase = argValue('out') ?? `outputs/ps-406/shipstation-duplicate-label-audit-${stamp}`;

  let labels: ShipStationAuditLabel[];
  let localEvidence: ShipStationLocalLabelEvidence[];
  let asOf = now;
  let sourceDateRange = { start: start.toISOString(), end: end.toISOString() };

  if (fixturePath) {
    const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8')) as Fixture;
    labels = fixture.labels;
    localEvidence = fixture.localEvidence;
    if (fixture.asOf) asOf = new Date(fixture.asOf);
    sourceDateRange = { start: fixture.start ?? null, end: fixture.end ?? null };
  } else {
    const clientName = argValue('client');
    if (!clientName) throw new Error('Live audit requires --client <exact PrepShip client name>.');
    const client = await resolveClient(clientName);
    const credentials = await loadClientCredentials(client.id);
    localEvidence = await loadLocalEvidence(client.id, client.name, start, end);
    const rawLabels = await listShipStationAuditLabels({
      apiKeyV2: credentials.apiKeyV2 ?? undefined,
      start: start.toISOString(),
      end: end.toISOString(),
      maxPages: Number(argValue('max-pages') ?? '100') || 100,
    });
    const initialLabels = rawLabels
      .map((raw) => normalizeShipStationAuditLabel(raw))
      .filter((label): label is ShipStationAuditLabel => label != null);
    const initial = auditShipStationDuplicateLabels({
      labels: initialLabels,
      localEvidence,
      asOf,
      duplicateWindowMinutes,
      sourceDateRange,
    });
    const candidateIds = [...new Set(initial.groups
      .filter((group) => group.classification !== 'NOT_DUPLICATE')
      .flatMap((group) => group.labels)
      .filter((label) => !label.voided)
      .map((label) => label.labelId))];
    const trackingRows = await mapWithConcurrency(candidateIds, 5, async (labelId) => ({
      labelId,
      tracking: await getShipStationAuditTracking(labelId, credentials.apiKeyV2 ?? undefined),
    }));
    const trackingByLabelId = new Map(trackingRows.map((row) => [row.labelId, row.tracking]));
    labels = rawLabels
      .map((raw) => {
        const rawLabelId = String(raw.label_id ?? raw.labelId ?? '');
        return normalizeShipStationAuditLabel(raw, trackingByLabelId.get(rawLabelId));
      })
      .filter((label): label is ShipStationAuditLabel => label != null);
  }

  const report = auditShipStationDuplicateLabels({
    labels,
    localEvidence,
    asOf,
    duplicateWindowMinutes,
    sourceDateRange,
  });
  const paths = writeReport(report, outputBase);
  console.log('PS-406 ShipStation duplicate-label audit - READ ONLY');
  console.log(`Date range: ${sourceDateRange.start ?? '(fixture)'} to ${sourceDateRange.end ?? '(fixture)'}`);
  console.log(`Labels: ${report.summary.labelsScanned}; candidate groups: ${report.summary.candidateGroups}; high confidence: ${report.summary.highConfidenceGroups}`);
  console.log(`Estimated potential refund: $${report.summary.estimatedPotentialRefundAmount.toFixed(2)}`);
  console.log(`JSON: ${paths.json}`);
  console.log(`CSV: ${paths.csv}`);
  console.log('No labels were voided, no refunds were requested, and no production data was mutated.');
}

const invokedDirectly = process.argv[1] != null && /audit-shipstation-duplicate-labels\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[ps-406] audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { loadLocalEvidence, renderCsv, writeReport };
