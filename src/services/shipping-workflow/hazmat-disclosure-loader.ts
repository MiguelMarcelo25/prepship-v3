import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  orderHazmatDeclarations,
  orderHazmatMaterials,
  shipmentHazmatSnapshots,
} from '../../db/schema/hazmat.js';
import { shipments } from '../../db/schema/shipments.js';
import { reportError } from '../../lib/structured-log.js';
import {
  hazmatSemanticHash,
  sealHazmatDeclaration,
  type CanonicalHazmatPurchaseFacts,
  type HazmatProfile,
  type NormalizedHazmatDeclaration,
  type NormalizedHazmatMaterial,
} from './hazmat-declaration.js';
import {
  resolveHazmatDisclosure,
  type ShipmentHazmatDisclosure,
  type UnreadableSeal,
} from './hazmat-disclosure.js';

// PS-477: the database half of the disclosure owner. It is deliberately split
// from hazmat-disclosure.ts so the reducer stays importable with no environment
// and no db client -- that is what makes the Task 1 guard a real proof that the
// rule is I/O-free.
//
// PS-477: moved from order-hazmat.ts (not redefined). Both declarationFromRows
// and purchaseFactsFromSnapshotRow now live next to the loaders and the reducer
// they feed, and loadDeclaration / loadFrozenPurchaseFacts in order-hazmat.ts
// call them instead of inlining. OrderHazmatError moved with
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

/**
 * Read seam. Defaults to the module singleton, exactly as loadDeclaration in
 * order-hazmat.ts does, so an in-process PGlite instance can drive the REAL
 * loaders in tests without any chance of reaching the production connection.
 */
export type HazmatDisclosureConn = Pick<typeof db, 'select'>;

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
 * PS-478: one list, two readers. `purchaseFactsFromSnapshotRow` rejects a row
 * whose profile is unrecognised, and the corrupt-row path needs the same
 * judgement to decide whether `summary_profile` is safe to surface. Keeping the
 * values in one place stops those two answers drifting apart.
 */
const HAZMAT_PROFILE_VALUES: readonly HazmatProfile[] = [
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

function isHazmatProfile(value: unknown): value is HazmatProfile {
  return typeof value === 'string' && HAZMAT_PROFILE_VALUES.includes(value as HazmatProfile);
}

/**
 * Row -> sealed purchase facts, moved verbatim out of order-hazmat.ts's
 * loadFrozenPurchaseFacts. Returns null only when there is no row (no
 * snapshot exists for this shipment) -- that is a normal, expected case
 * (most shipments are not hazmat). It still THROWS OrderHazmatError when a
 * row exists but fails shape or integrity validation: an append-only,
 * trigger-protected snapshot that reads back invalid is a real corruption
 * signal, not a "treat as absent" case, and the single-order edit/save path
 * (loadFrozenPurchaseFacts) must keep failing loudly with the exact prior
 * messages/code/status rather than quietly editing around a broken seal.
 *
 * The read-only batch loader below does NOT propagate that throw -- see
 * loadHazmatDisclosureForOrders for why, and for the disclosure rule it applies
 * instead.
 */
export function purchaseFactsFromSnapshotRow(
  row: HazmatSnapshotRow | undefined,
): CanonicalHazmatPurchaseFacts | null {
  if (!row) return null;
  const candidate = row.snapshotJson as Partial<CanonicalHazmatPurchaseFacts> | null;
  if (
    row.isHazmat !== true
    || !candidate?.declaration
    || !isHazmatProfile(row.profile)
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

/**
 * Loaders are deliberately thin: fetch both inputs, hand them to the reducer.
 * They must not contain any rule -- if a rule appears here, it belongs in
 * resolveHazmatDisclosure.
 *
 * Scope contract: `orderIds` must already be scope-checked by the caller.
 * This function applies no client/store predicate of its own -- it returns
 * disclosure for any id it is handed, so passing unscoped ids would leak
 * hazmat facts across tenants. That mirrors order-hazmat.ts's
 * loadDeclaration, which also takes a bare orderId and relies on scope being
 * enforced upstream by loadOrderRow(orderId, scope) (throws before
 * loadDeclaration runs). Both current callers already do this: getOrderHazmat
 * calls loadOrderRow first, and Print Queue's listQueue passes the already
 * scope-filtered visibleEntries set.
 */
export async function loadHazmatDisclosureForOrders(
  orderIds: number[],
  conn: HazmatDisclosureConn = db,
): Promise<Map<number, ShipmentHazmatDisclosure>> {
  const result = new Map<number, ShipmentHazmatDisclosure>();
  if (orderIds.length === 0) return result;

  // Latest snapshot per order. Same join as order-hazmat.ts's
  // loadFrozenPurchaseFacts, batched: ordered by shipment id desc, so the
  // first row seen per order is the latest.
  const snapshotRows = await conn
    .select({
      orderId: shipments.orderId,
      shipmentId: shipmentHazmatSnapshots.shipmentId,
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
  // Keyed on the ORDER, not on whether facts were produced. "Latest wins" must
  // mean the latest shipment's snapshot, full stop: a corrupt latest snapshot
  // that fell through to the catch below must NOT let the second-latest
  // shipment's older seal be presented as this shipment's current proof. That
  // divergence is invisible while the mapper always throws, and silently wrong
  // the moment it does not -- the single-order .limit(1) path never had it.
  const decidedSnapshotOrders = new Set<number>();
  // PS-478: orders whose latest seal exists but failed validation. Distinct
  // from being absent from snapshotByOrder, which now means only "no seal".
  const unreadableSealByOrder = new Map<number, UnreadableSeal>();
  for (const row of snapshotRows) {
    if (row.orderId == null || decidedSnapshotOrders.has(row.orderId)) continue;
    decidedSnapshotOrders.add(row.orderId);
    try {
      const facts = purchaseFactsFromSnapshotRow(row);
      if (facts) snapshotByOrder.set(row.orderId, facts);
    } catch (error) {
      // PS-477: one corrupt snapshot row must not blank hazmat for the whole
      // page. Before this catch, a single unreadable seal aborted the entire
      // batch and erased the dangerous-goods signal for every other order in
      // it -- the exact failure class PS-477 exists to close, inflicted on N-1
      // innocent orders.
      //
      // What corruption MEANS is the disclosure owner's rule, and it is stated
      // in resolveHazmatDisclosure's contract: an unverifiable seal is not
      // proof, so it is the same input as "no snapshot" and the order falls
      // back to its live declaration (still dangerous goods when that
      // declaration is active -- never a silent downgrade to 'none'). This
      // loader only applies that contract by leaving snapshotByOrder unset; it
      // decides nothing about what counts as hazmat. It is deliberately NOT the
      // consumer's decision either -- pushing it to Print Queue would recreate
      // the consumer-owns-the-rule drift PS-477 closes.
      //
      // Never swallowed: an append-only, trigger-protected snapshot that reads
      // back invalid is a real corruption signal and is surfaced structurally
      // so it is alertable. The single-order edit/save path in order-hazmat.ts
      // still throws, unchanged.
      // PS-478: record that a seal EXISTS here but could not be read. Leaving
      // this unset would collapse "corrupt" into "absent", which is what let a
      // shipment sealed as dangerous goods read back as `none` once its live
      // declaration had been retracted. summary_is_hazmat and summary_profile
      // carry their own DB CHECK constraints, so they survive a garbage
      // snapshot_json and are what the reducer consumes.
      unreadableSealByOrder.set(row.orderId, {
        summaryIsHazmat: row.isHazmat === true,
        summaryProfile: isHazmatProfile(row.profile) ? row.profile : null,
      });
      reportError('hazmat_disclosure_snapshot_corrupt', error, {
        orderId: row.orderId,
        shipmentId: row.shipmentId,
        snapshotHash: row.snapshotHash,
        profile: row.profile,
      });
    }
  }

  // Declarations plus their materials. Materials do not affect isHazmat today,
  // but the reducer delegates to summarizeHazmatDeclaration, which takes a whole
  // NormalizedHazmatDeclaration -- so we assemble a real one rather than a
  // partial with materials: [] that would quietly go wrong if that function ever
  // starts reading them.
  const headers = await conn
    .select()
    .from(orderHazmatDeclarations)
    .where(inArray(orderHazmatDeclarations.orderId, orderIds));

  const materialRows = headers.length === 0
    ? []
    : await conn
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
        unreadableSealByOrder.get(orderId) ?? null,
      ),
    );
  }
  return result;
}

export async function loadHazmatDisclosureForOrder(
  orderId: number,
  conn: HazmatDisclosureConn = db,
): Promise<ShipmentHazmatDisclosure> {
  const batch = await loadHazmatDisclosureForOrders([orderId], conn);
  return batch.get(orderId) ?? resolveHazmatDisclosure(null, null);
}
