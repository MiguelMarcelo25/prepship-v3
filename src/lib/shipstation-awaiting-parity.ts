export type PrepShipOrderStatus = 'awaiting_shipment' | 'shipped' | 'cancelled';

export type ShipStationAwaitingKey = {
  externalOrderId?: string | number | null;
  orderNumber?: string | null;
  storeId?: string | number | null;
};

export type ShipStationParityLocalOrder = {
  id: number;
  orderNumber: string;
  externalOrderId?: string | number | null;
  storeId?: string | number | null;
  currentStatus: string;
  rawStatus?: string | null;
  externallyShipped?: boolean | null;
  hasNonVoidedShipment?: boolean | null;
  latestShipmentVoided?: boolean | null;
  minutesSinceTerminal?: number | null;
  duplicateTerminalStatus?: PrepShipOrderStatus | null;
  marketplaceTerminalStatus?: PrepShipOrderStatus | null;
  shipStationTerminalStatus?: PrepShipOrderStatus | null;
};

export type ShipStationAwaitingParityFindingKind =
  | 'in_sync'
  | 'awaiting_with_terminal_evidence'
  | 'local_awaiting_missing_from_shipstation'
  | 'terminal_local_but_shipstation_awaiting';

export type ShipStationAwaitingParityFinding = {
  id: number;
  orderNumber: string;
  externalOrderId: string | null;
  storeId: number | null;
  currentStatus: string;
  targetStatus: PrepShipOrderStatus | null;
  kind: ShipStationAwaitingParityFindingKind;
  reason: string;
  sourceEvidence: string[];
  liveAwaiting: boolean;
  eligibleWithOverride: boolean;
  blockedByLockdown: boolean;
};

export type ShipStationAwaitingParityOptions = {
  terminalToAwaitingGraceMinutes?: number;
};

function cleanString(value: unknown): string {
  return String(value ?? '').trim();
}

function cleanStatus(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function nullableString(value: unknown): string | null {
  const text = cleanString(value);
  return text || null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function keyFor(value: ShipStationAwaitingKey): string | null {
  const externalOrderId = nullableString(value.externalOrderId);
  if (externalOrderId) return `external:${externalOrderId}`;
  const orderNumber = nullableString(value.orderNumber);
  const storeId = nullableNumber(value.storeId);
  if (orderNumber && storeId !== null) return `store-order:${storeId}:${orderNumber}`;
  if (orderNumber) return `order:${orderNumber}`;
  return null;
}

function keyVariants(value: ShipStationAwaitingKey): string[] {
  const keys = new Set<string>();
  const externalOrderId = nullableString(value.externalOrderId);
  const orderNumber = nullableString(value.orderNumber);
  const storeId = nullableNumber(value.storeId);
  if (externalOrderId) keys.add(`external:${externalOrderId}`);
  if (orderNumber && storeId !== null) keys.add(`store-order:${storeId}:${orderNumber}`);
  if (orderNumber) keys.add(`order:${orderNumber}`);
  const primary = keyFor(value);
  if (primary) keys.add(primary);
  return [...keys];
}

function isTerminalStatus(status: unknown): status is 'shipped' | 'cancelled' {
  const clean = cleanStatus(status);
  return clean === 'shipped' || clean === 'cancelled';
}

function terminalEvidence(order: ShipStationParityLocalOrder): {
  status: PrepShipOrderStatus | null;
  evidence: string[];
} {
  const entries: Array<[PrepShipOrderStatus | null | undefined, string]> = [
    [order.shipStationTerminalStatus, 'shipstation terminal status'],
    [order.marketplaceTerminalStatus, 'marketplace terminal status'],
    [order.duplicateTerminalStatus, 'duplicate local terminal row'],
  ];

  for (const [status, source] of entries) {
    if (isTerminalStatus(status)) {
      return { status, evidence: [source] };
    }
  }

  return { status: null, evidence: [] };
}

function terminalToAwaitingEligible(
  order: ShipStationParityLocalOrder,
  liveAwaiting: boolean,
  options: Required<ShipStationAwaitingParityOptions>,
): boolean {
  const rawAwaiting = cleanStatus(order.rawStatus) === 'awaiting_shipment';
  if (!liveAwaiting && !rawAwaiting) return false;
  if (order.externallyShipped === true) return false;
  if (order.hasNonVoidedShipment === true) return false;

  const hasVoidedShipment = order.latestShipmentVoided === true;
  const minutesSinceTerminal = Number(order.minutesSinceTerminal ?? Number.POSITIVE_INFINITY);
  const outsideGrace = minutesSinceTerminal >= options.terminalToAwaitingGraceMinutes;
  return hasVoidedShipment || outsideGrace;
}

export function classifyShipStationAwaitingParity(
  localOrders: ShipStationParityLocalOrder[],
  liveAwaitingOrders: ShipStationAwaitingKey[],
  options: ShipStationAwaitingParityOptions = {},
): ShipStationAwaitingParityFinding[] {
  const opts: Required<ShipStationAwaitingParityOptions> = {
    terminalToAwaitingGraceMinutes: options.terminalToAwaitingGraceMinutes ?? 10,
  };
  const liveKeys = new Set<string>();
  for (const liveOrder of liveAwaitingOrders) {
    for (const key of keyVariants(liveOrder)) liveKeys.add(key);
  }

  return localOrders.map((order) => {
    const liveAwaiting = keyVariants(order).some((key) => liveKeys.has(key));
    const orderNumber = cleanString(order.orderNumber);
    const externalOrderId = nullableString(order.externalOrderId);
    const storeId = nullableNumber(order.storeId);
    const currentStatus = cleanStatus(order.currentStatus);

    if (currentStatus === 'awaiting_shipment') {
      const evidence = terminalEvidence(order);
      if (evidence.status) {
        return {
          id: order.id,
          orderNumber,
          externalOrderId,
          storeId,
          currentStatus,
          targetStatus: evidence.status,
          kind: 'awaiting_with_terminal_evidence',
          reason: 'local awaiting row has terminal evidence and can move forward safely',
          sourceEvidence: evidence.evidence,
          liveAwaiting,
          eligibleWithOverride: false,
          blockedByLockdown: false,
        };
      }

      if (!liveAwaiting) {
        return {
          id: order.id,
          orderNumber,
          externalOrderId,
          storeId,
          currentStatus,
          targetStatus: null,
          kind: 'local_awaiting_missing_from_shipstation',
          reason: 'local awaiting row is missing from live ShipStation awaiting; terminal confirmation required before changing it',
          sourceEvidence: [],
          liveAwaiting,
          eligibleWithOverride: false,
          blockedByLockdown: false,
        };
      }
    }

    const rawAwaiting = cleanStatus(order.rawStatus) === 'awaiting_shipment';
    const voidedRawAwaiting =
      rawAwaiting &&
      order.latestShipmentVoided === true &&
      order.hasNonVoidedShipment !== true;
    if (isTerminalStatus(currentStatus) && (liveAwaiting || voidedRawAwaiting)) {
      const eligibleWithOverride = terminalToAwaitingEligible(order, liveAwaiting, opts);
      return {
        id: order.id,
        orderNumber,
        externalOrderId,
        storeId,
        currentStatus,
        targetStatus: 'awaiting_shipment',
        kind: 'terminal_local_but_shipstation_awaiting',
        reason: eligibleWithOverride
          ? 'ShipStation/raw status says awaiting and there is no active non-voided label, but terminal-row edits are locked'
          : 'ShipStation/raw status says awaiting, but local terminal state is still protected by active label/grace evidence',
        sourceEvidence: [
          ...(liveAwaiting ? ['live ShipStation awaiting'] : []),
          ...(cleanStatus(order.rawStatus) === 'awaiting_shipment' ? ['orders.raw awaiting_shipment'] : []),
          ...(order.latestShipmentVoided === true ? ['latest shipment voided'] : []),
          ...(order.hasNonVoidedShipment === true ? ['non-voided shipment exists'] : []),
        ],
        liveAwaiting,
        eligibleWithOverride,
        blockedByLockdown: true,
      };
    }

    return {
      id: order.id,
      orderNumber,
      externalOrderId,
      storeId,
      currentStatus,
      targetStatus: null,
      kind: 'in_sync',
      reason: 'no safe parity correction needed',
      sourceEvidence: liveAwaiting ? ['live ShipStation awaiting'] : [],
      liveAwaiting,
      eligibleWithOverride: false,
      blockedByLockdown: false,
    };
  });
}

export function shouldApplyShipStationAwaitingParityCandidate(
  candidate: ShipStationAwaitingParityFinding,
): boolean {
  return (
    candidate.kind === 'awaiting_with_terminal_evidence' &&
    candidate.currentStatus === 'awaiting_shipment' &&
    isTerminalStatus(candidate.targetStatus)
  );
}

export function shouldApplyShipStationAwaitingParityOverrideCandidate(
  candidate: ShipStationAwaitingParityFinding,
): boolean {
  return (
    candidate.kind === 'terminal_local_but_shipstation_awaiting' &&
    candidate.targetStatus === 'awaiting_shipment' &&
    candidate.eligibleWithOverride === true &&
    candidate.blockedByLockdown === true &&
    isTerminalStatus(candidate.currentStatus)
  );
}
