import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  orderHazmatDeclarations,
  orderHazmatMaterials,
  shipmentHazmatSnapshots,
} from '../../db/schema/hazmat.js';
import { shipments } from '../../db/schema/shipments.js';
import {
  hazmatSemanticHash,
  sealHazmatDeclaration,
  summarizeHazmatDeclaration,
  type CanonicalHazmatPurchaseFacts,
  type HazmatProfile,
  type NormalizedHazmatDeclaration,
  type NormalizedHazmatMaterial,
} from './hazmat-declaration.js';

/**
 * How well PrepShip knows what a shipment declared.
 *
 * - `sealed`            — an immutable snapshot was written at PrepShip purchase.
 * - `declared_unsealed` — an active declaration exists but PrepShip did not buy
 *                         the label, so nothing was sealed. Sync-ingested
 *                         shipments land here (shipment-sync.ts writes
 *                         source='shipstation' and knows nothing of the
 *                         declaration recorded minutes earlier).
 * - `none`              — not dangerous goods.
 */
export type HazmatProvenance = 'sealed' | 'declared_unsealed' | 'none';

export type ShipmentHazmatDisclosure = {
  isHazmat: boolean;
  profile: HazmatProfile | null;
  provenance: HazmatProvenance;
  snapshotHash: string | null;
  declarationRevision: number | null;
};

const NOT_HAZMAT: ShipmentHazmatDisclosure = {
  isHazmat: false,
  profile: null,
  provenance: 'none',
  snapshotHash: null,
  declarationRevision: null,
};

/**
 * The single rule. No I/O so it is directly testable at the boundary.
 *
 * A snapshot wins when present: it is proof of what was declared at purchase,
 * and a later declaration edit cannot change what was on the label.
 */
export function resolveHazmatDisclosure(
  snapshot: CanonicalHazmatPurchaseFacts | null,
  declaration: { declaration: NormalizedHazmatDeclaration | null; revision: number } | null,
): ShipmentHazmatDisclosure {
  if (snapshot) {
    return {
      isHazmat: summarizeHazmatDeclaration(snapshot.declaration).isHazmat,
      profile: snapshot.profile,
      provenance: 'sealed',
      snapshotHash: snapshot.snapshotHash,
      declarationRevision: snapshot.revision,
    };
  }
  if (!declaration?.declaration) return NOT_HAZMAT;
  // Delegated, never re-derived. summarizeHazmatDeclaration already owns
  // `status === 'active'`; a second copy here would recreate the drift that
  // broke Print Queue and the detail panel in different directions.
  if (!summarizeHazmatDeclaration(declaration.declaration).isHazmat) return NOT_HAZMAT;
  return {
    isHazmat: true,
    // Always null. A declaration has no profile field -- carrier profile is
    // resolved at rating/purchase by hazmat-capability.ts. For a label PrepShip
    // did not buy, the profile is genuinely unknown and null says so.
    profile: null,
    provenance: 'declared_unsealed',
    snapshotHash: null,
    declarationRevision: declaration.revision,
  };
}

// PS-477: moved from order-hazmat.ts (not redefined -- see below). Both
// declarationFromRows and purchaseFactsFromSnapshotRow now live next to the
// reducer they feed, and loadDeclaration / loadFrozenPurchaseFacts in
// order-hazmat.ts call them instead of inlining. OrderHazmatError moved with
// purchaseFactsFromSnapshotRow because it throws that class; order-hazmat.ts
// re-exports it so every existing importer (routes/order-hazmat.ts) is
// unaffected.
export class OrderHazmatError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 422 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrderHazmatError';
  }
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function materialFromRow(row: typeof orderHazmatMaterials.$inferSelect): NormalizedHazmatMaterial {
  return {
    sequence: row.sequence,
    unNaNumber: row.unNaNumber,
    properShippingName: row.properShippingName,
    technicalName: row.technicalName,
    hazardClass: row.hazardClass,
    subsidiaryHazardClass: row.subsidiaryHazardClass,
    packingGroup: row.packingGroup,
    amount: numberOrNull(row.amount),
    amountUnit: row.amountUnit,
    quantity: row.quantity,
    packagingInstruction: row.packagingInstruction,
    packagingInstructionSection: row.packagingInstructionSection,
    packagingType: row.packagingType,
    transportMean: row.transportMean,
    transportCategory: row.transportCategory,
    regulationAuthority: row.regulationAuthority,
    regulationLevel: row.regulationLevel,
    radioactive: row.radioactive === true,
    reportableQuantity: row.reportableQuantity === true,
    additionalDescription: row.additionalDescription,
  };
}

/**
 * Row -> declaration mapper, moved verbatim out of order-hazmat.ts's
 * loadDeclaration. Pure assembly, no querying and no rule: the caller reads
 * the header + materials rows, this turns them into the same
 * NormalizedHazmatDeclaration shape loadDeclaration always returned.
 */
export function declarationFromRows(
  header: typeof orderHazmatDeclarations.$inferSelect,
  materials: (typeof orderHazmatMaterials.$inferSelect)[],
): NormalizedHazmatDeclaration {
  return {
    schemaVersion: 1,
    status: header.status,
    limitedQuantity: header.limitedQuantity === true,
    containsBattery: header.containsBattery === true,
    dryIce: header.dryIce === true,
    dryIceWeightValue: numberOrNull(header.dryIceWeightValue),
    dryIceWeightUnit: header.dryIceWeightUnit,
    emergencyContactName: header.emergencyContactName,
    emergencyContactPhone: header.emergencyContactPhone,
    uspsCategory: header.uspsCategory,
    uspsPackageLevel: header.uspsPackageLevel,
    regulatedContentType: header.regulatedContentType,
    materials: materials.map(materialFromRow),
  };
}

type HazmatSnapshotRow = {
  snapshotJson: unknown;
  snapshotHash: string;
  revision: number;
  profile: string;
  isHazmat: boolean;
};

/**
 * Row -> sealed purchase facts, moved verbatim out of order-hazmat.ts's
 * loadFrozenPurchaseFacts. Returns null only when there is no row (no
 * snapshot exists for this shipment) -- that is a normal, expected case
 * (most shipments are not hazmat). It still THROWS OrderHazmatError when a
 * row exists but fails shape or integrity validation: an append-only,
 * trigger-protected snapshot that reads back invalid is a real corruption
 * signal, not a "treat as absent" case, and silently downgrading it to
 * "unsealed" (or "not hazmat") is exactly the bug class PS-477 exists to
 * close. This preserves loadFrozenPurchaseFacts's exact prior behaviour for
 * its single-order callers (unchanged messages/code/status), and the new
 * batch loader below deliberately does not swallow it either.
 */
export function purchaseFactsFromSnapshotRow(
  row: HazmatSnapshotRow | undefined,
): CanonicalHazmatPurchaseFacts | null {
  if (!row) return null;
  const profileValues: HazmatProfile[] = [
    'shipstation_usps',
    'shipstation_ups_dry_ice',
    'shipstation_ups_dangerous_goods',
    'ups_direct',
    'walmart',
    // Test-fixture snapshots are real rows and must read back, not be rejected
    // as invalid. Omitted when the profile was added, so a test label could be
    // written but never re-read.
    'prepship_test',
  ];
  const candidate = row.snapshotJson as Partial<CanonicalHazmatPurchaseFacts> | null;
  if (
    row.isHazmat !== true
    || !candidate?.declaration
    || !profileValues.includes(row.profile as HazmatProfile)
  ) {
    throw new OrderHazmatError(
      'The immutable hazmat snapshot is invalid.',
      'HAZMAT_SNAPSHOT_INVALID',
      409,
    );
  }
  try {
    const sealed = sealHazmatDeclaration({
      declaration: candidate.declaration,
      revision: row.revision,
      profile: row.profile as HazmatProfile,
    });
    if (
      candidate.revision !== row.revision
      || candidate.profile !== row.profile
      || candidate.declarationHash !== hazmatSemanticHash(candidate.declaration)
      || candidate.snapshotHash !== row.snapshotHash
      || sealed.snapshotHash !== row.snapshotHash
    ) {
      throw new Error('snapshot seal mismatch');
    }
    return sealed;
  } catch {
    throw new OrderHazmatError(
      'The immutable hazmat snapshot failed integrity verification.',
      'HAZMAT_SNAPSHOT_INVALID',
      409,
    );
  }
}

// Loaders are deliberately thin: fetch both inputs, hand them to the reducer.
// They must not contain any rule -- if a rule appears here, it belongs in
// resolveHazmatDisclosure.
export async function loadHazmatDisclosureForOrders(
  orderIds: number[],
): Promise<Map<number, ShipmentHazmatDisclosure>> {
  const result = new Map<number, ShipmentHazmatDisclosure>();
  if (orderIds.length === 0) return result;

  // Latest snapshot per order. Same join as order-hazmat.ts's
  // loadFrozenPurchaseFacts, batched: ordered by shipment id desc, so the
  // first row seen per order is the latest.
  const snapshotRows = await db
    .select({
      orderId: shipments.orderId,
      snapshotJson: shipmentHazmatSnapshots.snapshotJson,
      snapshotHash: shipmentHazmatSnapshots.snapshotHash,
      revision: shipmentHazmatSnapshots.orderDeclarationRevision,
      profile: shipmentHazmatSnapshots.summaryProfile,
      isHazmat: shipmentHazmatSnapshots.summaryIsHazmat,
    })
    .from(shipmentHazmatSnapshots)
    .innerJoin(shipments, eq(shipments.id, shipmentHazmatSnapshots.shipmentId))
    .where(inArray(shipments.orderId, orderIds))
    .orderBy(desc(shipments.id));

  const snapshotByOrder = new Map<number, CanonicalHazmatPurchaseFacts>();
  for (const row of snapshotRows) {
    if (row.orderId == null || snapshotByOrder.has(row.orderId)) continue;
    const facts = purchaseFactsFromSnapshotRow(row);
    if (facts) snapshotByOrder.set(row.orderId, facts);
  }

  // Declarations plus their materials. Materials do not affect isHazmat today,
  // but the reducer delegates to summarizeHazmatDeclaration, which takes a whole
  // NormalizedHazmatDeclaration -- so we assemble a real one rather than a
  // partial with materials: [] that would quietly go wrong if that function ever
  // starts reading them.
  const headers = await db
    .select()
    .from(orderHazmatDeclarations)
    .where(inArray(orderHazmatDeclarations.orderId, orderIds));

  const materialRows = headers.length === 0
    ? []
    : await db
        .select()
        .from(orderHazmatMaterials)
        .where(inArray(orderHazmatMaterials.orderId, headers.map((header) => header.orderId)))
        .orderBy(orderHazmatMaterials.sequence);

  const materialsByOrder = new Map<number, typeof materialRows>();
  for (const row of materialRows) {
    const list = materialsByOrder.get(row.orderId) ?? [];
    list.push(row);
    materialsByOrder.set(row.orderId, list);
  }

  const declarationByOrder = new Map<
    number,
    { declaration: NormalizedHazmatDeclaration; revision: number }
  >();
  for (const header of headers) {
    declarationByOrder.set(header.orderId, {
      declaration: declarationFromRows(header, materialsByOrder.get(header.orderId) ?? []),
      revision: header.revision,
    });
  }

  for (const orderId of orderIds) {
    result.set(
      orderId,
      resolveHazmatDisclosure(
        snapshotByOrder.get(orderId) ?? null,
        declarationByOrder.get(orderId) ?? null,
      ),
    );
  }
  return result;
}

export async function loadHazmatDisclosureForOrder(
  orderId: number,
): Promise<ShipmentHazmatDisclosure> {
  const batch = await loadHazmatDisclosureForOrders([orderId]);
  return batch.get(orderId) ?? resolveHazmatDisclosure(null, null);
}
