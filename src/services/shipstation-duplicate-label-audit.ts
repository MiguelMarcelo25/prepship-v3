import { createHash } from 'node:crypto';

export type AuditDimensions = {
  length: number | null;
  width: number | null;
  height: number | null;
};

export type AuditRecipient = {
  name: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  countryCode: string | null;
};

export type ShipStationAuditTracking = {
  statusCode: string | null;
  statusDescription: string | null;
  eventCount: number;
};

export type ShipStationAuditLabel = {
  labelId: string;
  shipmentId: string | null;
  externalOrderId: string | null;
  trackingNumber: string | null;
  createdAt: string;
  shipDate: string | null;
  carrierId: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipmentCost: number;
  insuranceCost: number;
  voided: boolean;
  voidedAt: string | null;
  refundStatus: string | null;
  chargeEvent: string | null;
  labelDownloadPresent: boolean;
  packageCount: number;
  totalWeightOz: number | null;
  dimensions: AuditDimensions | null;
  isReturnLabel: boolean;
  recipient: AuditRecipient;
  tracking: ShipStationAuditTracking | null;
};

export type ShipStationLocalLabelEvidence = {
  localShipmentId: number;
  orderId: number | null;
  orderNumber: string | null;
  externalOrderId: string | null;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  clientId: number | null;
  clientName: string | null;
  providerLabelId: string | null;
  labelShipmentId: number | null;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  weightOz: number | null;
  dimensions: AuditDimensions | null;
  recipient: AuditRecipient;
};

export type DuplicateClassification =
  | 'HIGH_CONFIDENCE'
  | 'SHIPSTATION_ONLY_DUPLICATE_CANDIDATE'
  | 'REVIEW_REQUIRED'
  | 'NOT_DUPLICATE';

export type DuplicateAction =
  | 'KEEP_USED'
  | 'VOID_CANDIDATE_DJ_REVIEW'
  | 'WAIT_REFUND_ASSIST'
  | 'REVIEW_ALL_UNSCANNED'
  | 'REVIEW_MULTI_PACKAGE_OR_REPLACEMENT'
  | 'IGNORE_ALREADY_VOIDED'
  | 'DO_NOT_VOID_SCANNED'
  | 'POST_BILLED_REPORTING_ONLY'
  | 'REVIEW_REQUIRED';

type LocalMatch = {
  row: ShipStationLocalLabelEvidence;
  matchedBy: 'provider_label_id' | 'shipment_id' | 'tracking_number' | 'external_order_id' | 'recipient_fingerprint';
};

type WorkingLabel = {
  label: ShipStationAuditLabel;
  localMatch: LocalMatch | null;
  recipientFingerprint: string;
  packageSignature: string;
  scanState: boolean | null;
};

export type DuplicateAuditLabelResult = {
  labelId: string;
  shipmentId: string | null;
  trackingNumber: string | null;
  createdAt: string;
  shipDate: string | null;
  carrierId: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipmentCost: number;
  insuranceCost: number;
  estimatedRefundAmount: number;
  voided: boolean;
  voidedAt: string | null;
  refundStatus: string | null;
  trackingStatusCode: string | null;
  trackingStatusDescription: string | null;
  trackingEventCount: number;
  scanned: boolean | null;
  labelDownloadPresent: boolean;
  packageCount: number;
  totalWeightOz: number | null;
  dimensions: AuditDimensions | null;
  redactedRecipient: string;
  recipientFingerprint: string;
  localShipmentId: number | null;
  orderId: number | null;
  orderNumber: string | null;
  clientId: number | null;
  clientName: string | null;
  matchedBy: LocalMatch['matchedBy'] | null;
  ageDays: number;
  withinUsps28DayWindow: boolean;
  withinUpsOther30DayWindow: boolean;
  refundAssistPossible: boolean;
  manualVoidWouldDisqualifyRefundAssist: boolean;
  action: DuplicateAction;
};

export type DuplicateAuditGroup = {
  groupKey: string;
  classification: DuplicateClassification;
  reason: string;
  labels: DuplicateAuditLabelResult[];
};

export type DuplicateLabelAuditReport = {
  generatedAt: string;
  sourceDateRange: { start: string | null; end: string | null };
  duplicateWindowMinutes: number;
  summary: {
    labelsScanned: number;
    groupsScanned: number;
    candidateGroups: number;
    highConfidenceGroups: number;
    shipStationOnlyCandidateGroups: number;
    reviewRequiredGroups: number;
    notDuplicateGroups: number;
    actionCounts: Record<DuplicateAction, number>;
    estimatedPotentialRefundAmount: number;
  };
  groups: DuplicateAuditGroup[];
  topCandidates: DuplicateAuditLabelResult[];
};

export type DuplicateLabelAuditInput = {
  labels: ShipStationAuditLabel[];
  localEvidence: ShipStationLocalLabelEvidence[];
  asOf?: Date;
  duplicateWindowMinutes?: number;
  sourceDateRange?: { start: string | null; end: string | null };
};

const SCANNED_CODES = new Set(['AC', 'IT', 'DE', 'EX', 'AT', 'SP']);
const UNSCANNED_CODES = new Set(['UN', 'NY']);
const POST_BILLED_EVENTS = new Set(['carrierpickup', 'manifest', 'postbilled', 'payonuse']);
const REFUND_ASSIST_STATUSES = new Set(['requestscheduled', 'pending']);
const REFUND_CANDIDATE_ACTIONS = new Set<DuplicateAction>([
  'VOID_CANDIDATE_DJ_REVIEW',
  'WAIT_REFUND_ASSIST',
]);
const TOP_CANDIDATE_ACTIONS = new Set<DuplicateAction>([
  ...REFUND_CANDIDATE_ACTIONS,
  'REVIEW_ALL_UNSCANNED',
]);

const ACTIONS: DuplicateAction[] = [
  'KEEP_USED',
  'VOID_CANDIDATE_DJ_REVIEW',
  'WAIT_REFUND_ASSIST',
  'REVIEW_ALL_UNSCANNED',
  'REVIEW_MULTI_PACKAGE_OR_REPLACEMENT',
  'IGNORE_ALREADY_VOIDED',
  'DO_NOT_VOID_SCANNED',
  'POST_BILLED_REPORTING_ONLY',
  'REVIEW_REQUIRED',
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function number(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function money(value: unknown): number {
  return Number((number(record(value).amount) ?? number(value) ?? 0).toFixed(2));
}

function normalized(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeWeightOz(value: unknown): number | null {
  const weight = record(value);
  const amount = number(weight.value);
  if (amount == null) return null;
  const unit = normalized(text(weight.unit ?? weight.units));
  if (unit.startsWith('pound') || unit === 'lb') return Number((amount * 16).toFixed(2));
  if (unit.startsWith('gram')) return Number((amount * 0.035274).toFixed(2));
  if (unit.startsWith('kilogram') || unit === 'kg') return Number((amount * 35.274).toFixed(2));
  return Number(amount.toFixed(2));
}

function normalizeDimensions(value: unknown): AuditDimensions | null {
  const dims = record(value);
  const length = number(dims.length);
  const width = number(dims.width);
  const height = number(dims.height);
  if (length == null && width == null && height == null) return null;
  const factor = normalized(text(dims.unit ?? dims.units)).startsWith('centimeter') ? 0.393701 : 1;
  const convert = (part: number | null) => part == null ? null : Number((part * factor).toFixed(2));
  return { length: convert(length), width: convert(width), height: convert(height) };
}

function trackingFromRaw(raw: unknown): ShipStationAuditTracking | null {
  const value = record(raw);
  const statusCode = text(value.status_code ?? value.statusCode);
  const statusDescription = text(value.status_description ?? value.statusDescription);
  const events = Array.isArray(value.events) ? value.events : [];
  if (!statusCode && !statusDescription && events.length === 0) return null;
  return { statusCode, statusDescription, eventCount: events.length };
}

export function normalizeShipStationAuditLabel(
  rawValue: unknown,
  trackingValue?: unknown,
): ShipStationAuditLabel | null {
  const raw = record(rawValue);
  const labelId = text(raw.label_id ?? raw.labelId);
  const createdAt = text(raw.created_at ?? raw.createdAt);
  if (!labelId || !createdAt) return null;
  const packages = Array.isArray(raw.packages) ? raw.packages.map(record) : [];
  const packageWeights = packages.map((pkg) => normalizeWeightOz(pkg.weight)).filter((v): v is number => v != null);
  const firstPackage = packages[0] ?? {};
  const shipTo = record(raw.ship_to ?? raw.shipTo);
  const embeddedTracking = text(raw.tracking_status ?? raw.trackingStatus);
  const explicitTracking = trackingFromRaw(trackingValue);
  const tracking = explicitTracking ?? (embeddedTracking ? {
    statusCode: embeddedTracking,
    statusDescription: embeddedTracking.replace(/_/g, ' '),
    eventCount: 0,
  } : null);

  return {
    labelId,
    shipmentId: text(raw.shipment_id ?? raw.shipmentId),
    externalOrderId: text(raw.external_order_id ?? raw.externalOrderId),
    trackingNumber: text(raw.tracking_number ?? raw.trackingNumber),
    createdAt,
    shipDate: text(raw.ship_date ?? raw.shipDate),
    carrierId: text(raw.carrier_id ?? raw.carrierId),
    carrierCode: text(raw.carrier_code ?? raw.carrierCode),
    serviceCode: text(raw.service_code ?? raw.serviceCode),
    shipmentCost: money(raw.shipment_cost ?? raw.shipmentCost),
    insuranceCost: money(raw.insurance_cost ?? raw.insuranceCost),
    voided: Boolean(raw.voided) || normalized(text(raw.status)) === 'voided',
    voidedAt: text(raw.voided_at ?? raw.voidedAt),
    refundStatus: text(raw.refund_status ?? raw.refundStatus),
    chargeEvent: text(raw.charge_event ?? raw.chargeEvent),
    labelDownloadPresent: Object.values(record(raw.label_download ?? raw.labelDownload)).some((value) => Boolean(text(value))),
    packageCount: packages.length || 1,
    totalWeightOz: packageWeights.length
      ? Number(packageWeights.reduce((sum, value) => sum + value, 0).toFixed(2))
      : normalizeWeightOz(raw.weight),
    dimensions: normalizeDimensions(firstPackage.dimensions ?? raw.dimensions),
    isReturnLabel: Boolean(raw.is_return_label ?? raw.isReturnLabel),
    recipient: {
      name: text(shipTo.name ?? shipTo.company_name ?? shipTo.companyName),
      city: text(shipTo.city_locality ?? shipTo.city),
      state: text(shipTo.state_province ?? shipTo.state),
      postalCode: text(shipTo.postal_code ?? shipTo.postalCode),
      countryCode: text(shipTo.country_code ?? shipTo.countryCode),
    },
    tracking,
  };
}

function recipientIdentity(recipient: AuditRecipient): string {
  return [recipient.name, recipient.city, recipient.state, recipient.postalCode, recipient.countryCode]
    .map(normalized)
    .join('|');
}

function fingerprint(recipient: AuditRecipient): string {
  const identity = recipientIdentity(recipient);
  return identity.replace(/\|/g, '')
    ? createHash('sha256').update(identity).digest('hex').slice(0, 16)
    : 'unknown';
}

function redactRecipient(recipient: AuditRecipient): string {
  const initial = text(recipient.name)?.slice(0, 1).toUpperCase() ?? '?';
  const postal = normalized(recipient.postalCode);
  const postalSuffix = postal ? postal.slice(-2) : '??';
  const state = text(recipient.state)?.toUpperCase() ?? '??';
  return `${initial}*** / ***${postalSuffix} / ${state}`;
}

function dimsSignature(dims: AuditDimensions | null): string {
  if (!dims) return '?x?x?';
  return [dims.length, dims.width, dims.height]
    .map((value) => value == null ? '?' : Number(value.toFixed(2)))
    .join('x');
}

function packageSignature(label: ShipStationAuditLabel): string {
  const weight = label.totalWeightOz == null ? '?' : Number(label.totalWeightOz.toFixed(2));
  return `${label.packageCount}|${weight}|${dimsSignature(label.dimensions)}`;
}

function scanState(label: ShipStationAuditLabel): boolean | null {
  const status = String(label.tracking?.statusCode ?? '').trim().toUpperCase();
  if (SCANNED_CODES.has(status)) return true;
  if (UNSCANNED_CODES.has(status)) return false;
  const normalizedStatus = normalized(status);
  if (['accepted', 'intransit', 'delivered', 'exception', 'deliveryattempt'].includes(normalizedStatus)) return true;
  if (['unknown', 'notyetinsystem'].includes(normalizedStatus)) return false;
  return label.tracking && label.tracking.eventCount > 0 ? true : null;
}

function idVariants(value: string | number | null | undefined): string[] {
  const raw = normalized(value == null ? null : String(value));
  if (!raw) return [];
  return [...new Set([raw, raw.replace(/^se/, '')])];
}

function orderVariants(row: ShipStationLocalLabelEvidence): string[] {
  return [...new Set([
    row.externalOrderId,
    row.sourceOrderId,
    row.sourceOrderNumber,
    row.orderNumber,
  ].flatMap(idVariants))];
}

function addIndex(
  index: Map<string, ShipStationLocalLabelEvidence[]>,
  keys: string[],
  row: ShipStationLocalLabelEvidence,
): void {
  for (const key of keys) index.set(key, [...(index.get(key) ?? []), row]);
}

function first(index: Map<string, ShipStationLocalLabelEvidence[]>, keys: string[]): ShipStationLocalLabelEvidence | null {
  for (const key of keys) {
    const match = index.get(key)?.[0];
    if (match) return match;
  }
  return null;
}

function matchLocalEvidence(
  labels: ShipStationAuditLabel[],
  rows: ShipStationLocalLabelEvidence[],
): WorkingLabel[] {
  const byProviderLabel = new Map<string, ShipStationLocalLabelEvidence[]>();
  const byShipment = new Map<string, ShipStationLocalLabelEvidence[]>();
  const byTracking = new Map<string, ShipStationLocalLabelEvidence[]>();
  const byOrder = new Map<string, ShipStationLocalLabelEvidence[]>();
  const byRecipient = new Map<string, ShipStationLocalLabelEvidence[]>();

  for (const row of rows) {
    addIndex(byProviderLabel, idVariants(row.providerLabelId), row);
    addIndex(byShipment, idVariants(row.labelShipmentId), row);
    addIndex(byTracking, idVariants(row.trackingNumber), row);
    addIndex(byOrder, orderVariants(row), row);
    addIndex(byRecipient, [recipientIdentity(row.recipient)], row);
  }

  return labels.map((label) => {
    const matchCandidates: Array<[LocalMatch['matchedBy'], ShipStationLocalLabelEvidence | null]> = [
      ['provider_label_id', first(byProviderLabel, idVariants(label.labelId))],
      ['shipment_id', first(byShipment, idVariants(label.shipmentId))],
      ['tracking_number', first(byTracking, idVariants(label.trackingNumber))],
      ['external_order_id', first(byOrder, idVariants(label.externalOrderId))],
      ['recipient_fingerprint', first(byRecipient, [recipientIdentity(label.recipient)])],
    ];
    const matched = matchCandidates.find(([, row]) => row != null);
    return {
      label,
      localMatch: matched?.[1] ? { row: matched[1], matchedBy: matched[0] } : null,
      recipientFingerprint: fingerprint(label.recipient),
      packageSignature: packageSignature(label),
      scanState: scanState(label),
    };
  });
}

function groupAnchor(row: WorkingLabel): string {
  if (row.localMatch?.matchedBy !== 'recipient_fingerprint' && row.localMatch?.row.orderId != null) {
    return `local-order:${row.localMatch.row.orderId}`;
  }
  const externalOrder = normalized(row.label.externalOrderId);
  if (externalOrder) return `external-order:${externalOrder}`;
  return [
    'recipient',
    row.recipientFingerprint,
    normalized(row.label.carrierCode),
    normalized(row.label.serviceCode),
    row.packageSignature,
  ].join(':');
}

function splitByTimeWindow(rows: WorkingLabel[], windowMs: number): WorkingLabel[][] {
  const sorted = [...rows].sort((a, b) => Date.parse(a.label.createdAt) - Date.parse(b.label.createdAt));
  const groups: WorkingLabel[][] = [];
  for (const row of sorted) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || Date.parse(row.label.createdAt) - Date.parse(previous.label.createdAt) > windowMs) {
      groups.push([row]);
    } else {
      current.push(row);
    }
  }
  return groups;
}

function classify(rows: WorkingLabel[]): { classification: DuplicateClassification; reason: string } {
  if (rows.length < 2) return { classification: 'NOT_DUPLICATE', reason: 'Only one label matched this order/fingerprint in the time window.' };
  const active = rows.filter((row) => !row.label.voided);
  const scanned = active.filter((row) => row.scanState === true);
  const unscanned = active.filter((row) => row.scanState === false);
  const sameService = new Set(active.map((row) => normalized(row.label.serviceCode))).size <= 1;
  const samePackage = new Set(active.map((row) => row.packageSignature)).size <= 1;
  const sameLocalOrder = new Set(active.map((row) => row.localMatch?.row.orderId).filter((id) => id != null)).size <= 1;
  const hasLocal = active.some((row) => row.localMatch != null);
  const hasStrongLocalMatch = active.some((row) => row.localMatch?.matchedBy !== 'recipient_fingerprint');

  if (hasStrongLocalMatch && sameLocalOrder && sameService && samePackage && scanned.length > 0 && unscanned.length > 0) {
    return { classification: 'HIGH_CONFIDENCE', reason: 'Same local order, service, and package has a used/scanned label plus an unscanned label.' };
  }
  if (!hasLocal && sameService && samePackage) {
    return { classification: 'SHIPSTATION_ONLY_DUPLICATE_CANDIDATE', reason: 'ShipStation labels share an order/address/package fingerprint but no PrepShip shipment matched.' };
  }
  return { classification: 'REVIEW_REQUIRED', reason: 'Multiple close labels matched, but usage, package, service, or local-order evidence is not decisive.' };
}

function isUsps(label: ShipStationAuditLabel): boolean {
  return ['usps', 'stamps', 'endicia'].some((value) => normalized(label.carrierCode).includes(value))
    || normalized(label.serviceCode).startsWith('usps');
}

function ageDays(createdAt: string, asOf: Date): number {
  const elapsed = Math.max(0, asOf.getTime() - Date.parse(createdAt));
  return Number((elapsed / 86_400_000).toFixed(2));
}

function isPostBilled(label: ShipStationAuditLabel): boolean {
  return POST_BILLED_EVENTS.has(normalized(label.chargeEvent));
}

function actionFor(
  row: WorkingLabel,
  rows: WorkingLabel[],
  classification: DuplicateClassification,
  refundAssistPossible: boolean,
): DuplicateAction {
  if (row.label.voided) return 'IGNORE_ALREADY_VOIDED';
  if (classification === 'NOT_DUPLICATE') return 'KEEP_USED';
  if (rows.some((item) => item.label.packageCount > 1 || item.label.isReturnLabel)) {
    return row.scanState === true ? 'KEEP_USED' : 'REVIEW_MULTI_PACKAGE_OR_REPLACEMENT';
  }
  const scanned = rows.filter((item) => !item.label.voided && item.scanState === true);
  const knownUnscanned = rows.filter((item) => !item.label.voided && item.scanState === false);
  const unknown = rows.filter((item) => !item.label.voided && item.scanState == null);
  if (row.scanState === true) return scanned[0] === row ? 'KEEP_USED' : 'DO_NOT_VOID_SCANNED';
  if (row.scanState == null || unknown.length > 0) return 'REVIEW_REQUIRED';
  if (isPostBilled(row.label)) return 'POST_BILLED_REPORTING_ONLY';
  if (scanned.length === 0 && knownUnscanned.length > 1) return 'REVIEW_ALL_UNSCANNED';
  if (refundAssistPossible) return 'WAIT_REFUND_ASSIST';
  return classification === 'HIGH_CONFIDENCE'
    ? 'VOID_CANDIDATE_DJ_REVIEW'
    : 'REVIEW_REQUIRED';
}

function resultFor(
  row: WorkingLabel,
  rows: WorkingLabel[],
  classification: DuplicateClassification,
  asOf: Date,
): DuplicateAuditLabelResult {
  const age = ageDays(row.label.createdAt, asOf);
  const usps = isUsps(row.label);
  const withinUsps28DayWindow = usps && age <= 28;
  const withinUpsOther30DayWindow = !usps && age <= 30;
  const refundAssistPossible = !row.label.voided
    && row.scanState === false
    && withinUsps28DayWindow
    && REFUND_ASSIST_STATUSES.has(normalized(row.label.refundStatus));
  const action = actionFor(row, rows, classification, refundAssistPossible);
  const estimatedRefundAmount = REFUND_CANDIDATE_ACTIONS.has(action)
    ? Number((row.label.shipmentCost + row.label.insuranceCost).toFixed(2))
    : 0;
  const local = row.localMatch?.row;

  return {
    labelId: row.label.labelId,
    shipmentId: row.label.shipmentId,
    trackingNumber: row.label.trackingNumber,
    createdAt: row.label.createdAt,
    shipDate: row.label.shipDate,
    carrierId: row.label.carrierId,
    carrierCode: row.label.carrierCode,
    serviceCode: row.label.serviceCode,
    shipmentCost: row.label.shipmentCost,
    insuranceCost: row.label.insuranceCost,
    estimatedRefundAmount,
    voided: row.label.voided,
    voidedAt: row.label.voidedAt,
    refundStatus: row.label.refundStatus,
    trackingStatusCode: row.label.tracking?.statusCode ?? null,
    trackingStatusDescription: row.label.tracking?.statusDescription ?? null,
    trackingEventCount: row.label.tracking?.eventCount ?? 0,
    scanned: row.scanState,
    labelDownloadPresent: row.label.labelDownloadPresent,
    packageCount: row.label.packageCount,
    totalWeightOz: row.label.totalWeightOz,
    dimensions: row.label.dimensions,
    redactedRecipient: redactRecipient(row.label.recipient),
    recipientFingerprint: row.recipientFingerprint,
    localShipmentId: local?.localShipmentId ?? null,
    orderId: local?.orderId ?? null,
    orderNumber: local?.orderNumber ?? null,
    clientId: local?.clientId ?? null,
    clientName: local?.clientName ?? null,
    matchedBy: row.localMatch?.matchedBy ?? null,
    ageDays: age,
    withinUsps28DayWindow,
    withinUpsOther30DayWindow,
    refundAssistPossible,
    manualVoidWouldDisqualifyRefundAssist: refundAssistPossible,
    action,
  };
}

export function auditShipStationDuplicateLabels(input: DuplicateLabelAuditInput): DuplicateLabelAuditReport {
  const asOf = input.asOf ?? new Date();
  const duplicateWindowMinutes = Math.max(1, input.duplicateWindowMinutes ?? 60);
  const working = matchLocalEvidence(input.labels, input.localEvidence);
  const anchors = new Map<string, WorkingLabel[]>();
  for (const row of working) {
    const key = groupAnchor(row);
    anchors.set(key, [...(anchors.get(key) ?? []), row]);
  }

  const groups: DuplicateAuditGroup[] = [];
  for (const [anchor, rows] of anchors) {
    const split = splitByTimeWindow(rows, duplicateWindowMinutes * 60_000);
    split.forEach((windowRows, index) => {
      const { classification, reason } = classify(windowRows);
      groups.push({
        groupKey: `${anchor}:window-${index + 1}`,
        classification,
        reason,
        labels: windowRows.map((row) => resultFor(row, windowRows, classification, asOf)),
      });
    });
  }

  const actionCounts = Object.fromEntries(ACTIONS.map((action) => [action, 0])) as Record<DuplicateAction, number>;
  for (const group of groups) for (const label of group.labels) actionCounts[label.action] += 1;
  const candidateGroups = groups.filter((group) => group.classification !== 'NOT_DUPLICATE');
  const topCandidates = candidateGroups
    .flatMap((group) => group.labels)
    .filter((label) => TOP_CANDIDATE_ACTIONS.has(label.action))
    .sort((a, b) => b.estimatedRefundAmount - a.estimatedRefundAmount)
    .slice(0, 25);

  return {
    generatedAt: asOf.toISOString(),
    sourceDateRange: input.sourceDateRange ?? { start: null, end: null },
    duplicateWindowMinutes,
    summary: {
      labelsScanned: input.labels.length,
      groupsScanned: groups.length,
      candidateGroups: candidateGroups.length,
      highConfidenceGroups: groups.filter((group) => group.classification === 'HIGH_CONFIDENCE').length,
      shipStationOnlyCandidateGroups: groups.filter((group) => group.classification === 'SHIPSTATION_ONLY_DUPLICATE_CANDIDATE').length,
      reviewRequiredGroups: groups.filter((group) => group.classification === 'REVIEW_REQUIRED').length,
      notDuplicateGroups: groups.filter((group) => group.classification === 'NOT_DUPLICATE').length,
      actionCounts,
      estimatedPotentialRefundAmount: Number(
        candidateGroups.flatMap((group) => group.labels)
          .reduce((sum, label) => sum + label.estimatedRefundAmount, 0)
          .toFixed(2),
      ),
    },
    groups,
    topCandidates,
  };
}
