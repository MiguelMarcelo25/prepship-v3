/**
 * PS-289 - pure runtime compatibility helpers for future real print queue
 * integration.
 *
 * The current print queue table stores `orderId` as text but many runtime paths
 * still treat it as a numeric source order id. Multi-package rows need
 * package-scoped ids to avoid the unique(orderId, clientId) collision, so this
 * helper makes the source order explicit before any real insert/printer path is
 * enabled.
 *
 * Pure only: no DB, no printer, no label purchase, no marketplace call, no
 * order/shipment mutation.
 */

export type MultiPackagePrintQueueOrderIdParts = {
  sourceOrderId: number;
  packageSequence: number;
  packageKey: string;
};

export type PrintQueueRuntimeEntryLike = {
  id: string;
  orderId: string | number;
  clientId: number;
};

export type PrintQueueRuntimeCompatEntry = {
  id: string;
  clientId: number;
  orderId: string;
  sourceOrderId: number;
  isMultiPackage: boolean;
  packageSequence: number | null;
  packageKey: string | null;
};

export type PrintQueueRuntimeCompatPlan = {
  entries: PrintQueueRuntimeCompatEntry[];
  sourceOrderIds: number[];
  hasMultiPackageEntries: boolean;
  compatibleWithNumericSourceOrderLookups: boolean;
};

export function parseMultiPackagePrintQueueOrderId(orderId: string | number): MultiPackagePrintQueueOrderIdParts | null {
  const text = String(orderId ?? '').trim();
  const match = /^mp:(\d+):(\d+):([A-Za-z0-9._:-]+)$/.exec(text);
  if (!match) return null;

  const sourceOrderId = Number(match[1]);
  const packageSequence = Number(match[2]);
  const packageKey = match[3]?.trim() ?? '';
  if (!Number.isSafeInteger(sourceOrderId) || sourceOrderId <= 0) return null;
  if (!Number.isSafeInteger(packageSequence) || packageSequence <= 0) return null;
  if (!packageKey) return null;

  return { sourceOrderId, packageSequence, packageKey };
}

export function resolvePrintQueueSourceOrderId(orderId: string | number): number | null {
  const multiPackage = parseMultiPackagePrintQueueOrderId(orderId);
  if (multiPackage) return multiPackage.sourceOrderId;

  const numeric = Number(orderId);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

export function buildPrintQueueRuntimeCompatPlan(
  entries: PrintQueueRuntimeEntryLike[],
): PrintQueueRuntimeCompatPlan {
  const sourceOrderIds = new Set<number>();
  const compatEntries = entries.map((entry) => {
    const multiPackage = parseMultiPackagePrintQueueOrderId(entry.orderId);
    const sourceOrderId = resolvePrintQueueSourceOrderId(entry.orderId);
    if (sourceOrderId == null) {
      throw new Error(`Print queue entry ${entry.id} does not resolve to a numeric source order id`);
    }
    sourceOrderIds.add(sourceOrderId);
    return {
      id: entry.id,
      clientId: entry.clientId,
      orderId: String(entry.orderId),
      sourceOrderId,
      isMultiPackage: multiPackage != null,
      packageSequence: multiPackage?.packageSequence ?? null,
      packageKey: multiPackage?.packageKey ?? null,
    };
  });

  return {
    entries: compatEntries,
    sourceOrderIds: [...sourceOrderIds].sort((left, right) => left - right),
    hasMultiPackageEntries: compatEntries.some((entry) => entry.isMultiPackage),
    compatibleWithNumericSourceOrderLookups: compatEntries.every((entry) => Number.isSafeInteger(entry.sourceOrderId)),
  };
}
