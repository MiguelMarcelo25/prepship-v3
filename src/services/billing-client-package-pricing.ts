import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { billingLineItems, clientPackagePrices } from '../db/schema/billing';
import { packages as packagesTable } from '../db/schema/packages';
import { shipments } from '../db/schema/shipments';
import {
  boxDimsKey,
  resolveShippedPackageId,
  type BoxLookups,
  type BoxPackage,
} from './billing-box-policy';

type PackageSource = 'billing_line_item' | 'shipment_selected_pid' | 'shipment_selected_package_code' | 'shipment_dims';

export type ClientPackagePricingPackage = {
  id?: number | null;
  packageId?: number | null;
  name?: string | null;
  packageCode?: string | null;
  source?: string | null;
  length?: number | string | null;
  width?: number | string | null;
  height?: number | string | null;
  unitCost?: number | string | null;
};

export type ClientPackagePricingSavedPrice = {
  packageId: number;
  price: number | string;
  isCustom?: boolean | null;
  is_custom?: boolean | null;
};

export type ClientPackagePricingShipmentEvidence = {
  selectedPid?: number | string | null;
  selectedPackageId?: string | null;
  dimsL?: number | string | null;
  dimsW?: number | string | null;
  dimsH?: number | string | null;
};

export type ClientUsedPackagePricingRow = {
  packageId: number;
  name: string;
  length: number | null;
  width: number | null;
  height: number | null;
  dimsText: string;
  unitCost: number | null;
  ourCost: number | null;
  price: number;
  charge: number;
  isCustom: boolean;
  is_custom: boolean;
  marginPct: number | null;
  usageCount: number;
  usageSources: PackageSource[];
};

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toPackageId(pkg: ClientPackagePricingPackage): number | null {
  const id = toFiniteNumber(pkg.packageId ?? pkg.id);
  return id !== null && Number.isInteger(id) && id > 0 ? id : null;
}

function toBoxPackage(pkg: ClientPackagePricingPackage): BoxPackage | null {
  const id = toPackageId(pkg);
  if (id === null) return null;
  return {
    id,
    name: pkg.name ?? null,
    packageCode: pkg.packageCode ?? null,
    length: toFiniteNumber(pkg.length) ?? 0,
    width: toFiniteNumber(pkg.width) ?? 0,
    height: toFiniteNumber(pkg.height) ?? 0,
    source: pkg.source ?? null,
  };
}

function isPricingPackage(pkg: ClientPackagePricingPackage): boolean {
  return (pkg.source ?? 'custom') === 'custom';
}

function buildLookups(packageRows: ClientPackagePricingPackage[]): BoxLookups {
  const byId = new Map<number, BoxPackage>();
  const byCode = new Map<string, BoxPackage>();
  const byDims = new Map<string, BoxPackage>();

  for (const row of packageRows) {
    const pkg = toBoxPackage(row);
    if (!pkg) continue;
    byId.set(pkg.id, pkg);
    if (pkg.packageCode) byCode.set(pkg.packageCode, pkg);
    const dimsKey = boxDimsKey(pkg.length, pkg.width, pkg.height);
    if (dimsKey && !byDims.has(dimsKey)) byDims.set(dimsKey, pkg);
  }

  return { byId, byCode, byDims };
}

function noteUsage(
  usage: Map<number, { count: number; sources: Set<PackageSource> }>,
  packageId: number | null,
  source: PackageSource,
) {
  if (packageId === null || !Number.isInteger(packageId) || packageId <= 0) return;
  const current = usage.get(packageId) ?? { count: 0, sources: new Set<PackageSource>() };
  current.count += 1;
  current.sources.add(source);
  usage.set(packageId, current);
}

function formatDims(l: number | null, w: number | null, h: number | null): string {
  return l !== null && w !== null && h !== null ? `${l}x${w}x${h}"` : '-';
}

function marginPct(charge: number, ourCost: number | null): number | null {
  if (ourCost === null || charge <= 0) return null;
  return Number.parseFloat((((charge - ourCost) / charge) * 100).toFixed(0));
}

export function buildClientUsedPackagePricingRows(input: {
  packages: ClientPackagePricingPackage[];
  savedPrices: ClientPackagePricingSavedPrice[];
  billingPackageIds?: Array<number | string | null | undefined>;
  shipmentEvidence?: ClientPackagePricingShipmentEvidence[];
}): ClientUsedPackagePricingRow[] {
  const pricingPackages = input.packages.filter(isPricingPackage);
  const packagesById = new Map<number, ClientPackagePricingPackage>();
  const savedByPackageId = new Map<number, ClientPackagePricingSavedPrice>();
  const usage = new Map<number, { count: number; sources: Set<PackageSource> }>();

  for (const pkg of pricingPackages) {
    const id = toPackageId(pkg);
    if (id !== null) packagesById.set(id, pkg);
  }

  for (const saved of input.savedPrices) {
    savedByPackageId.set(saved.packageId, saved);
  }

  for (const rawId of input.billingPackageIds ?? []) {
    const packageId = toFiniteNumber(rawId);
    if (packageId !== null && packagesById.has(packageId)) {
      noteUsage(usage, packageId, 'billing_line_item');
    }
  }

  const lookups = buildLookups(pricingPackages);
  for (const evidence of input.shipmentEvidence ?? []) {
    const resolution = resolveShippedPackageId({
      operator: null,
      selectedPid: toFiniteNumber(evidence.selectedPid),
      selectedPackageId: evidence.selectedPackageId ?? null,
      dimsL: toFiniteNumber(evidence.dimsL),
      dimsW: toFiniteNumber(evidence.dimsW),
      dimsH: toFiniteNumber(evidence.dimsH),
      lookups,
    });
    if (resolution.status === 'resolved' && resolution.packageId !== null && packagesById.has(resolution.packageId)) {
      const source: PackageSource =
        resolution.source === 'selected_pid'
          ? 'shipment_selected_pid'
          : resolution.source === 'selected_package_code'
            ? 'shipment_selected_package_code'
            : 'shipment_dims';
      noteUsage(usage, resolution.packageId, source);
    }
  }

  return Array.from(usage.entries())
    .map(([packageId, evidence]) => {
      const pkg = packagesById.get(packageId)!;
      const saved = savedByPackageId.get(packageId);
      const length = toFiniteNumber(pkg.length);
      const width = toFiniteNumber(pkg.width);
      const height = toFiniteNumber(pkg.height);
      const ourCost = toFiniteNumber(pkg.unitCost);
      const charge = toFiniteNumber(saved?.price) ?? 0;
      const isCustom = saved ? Boolean(saved.isCustom ?? saved.is_custom) : false;
      return {
        packageId,
        name: pkg.name ?? `Box #${packageId}`,
        length,
        width,
        height,
        dimsText: formatDims(length, width, height),
        unitCost: ourCost,
        ourCost,
        price: charge,
        charge,
        isCustom,
        is_custom: isCustom,
        marginPct: marginPct(charge, ourCost),
        usageCount: evidence.count,
        usageSources: Array.from(evidence.sources).sort(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.packageId - b.packageId);
}

export async function clientUsedPackagePricingRows(clientId: number): Promise<ClientUsedPackagePricingRow[]> {
  const [packageRows, savedPrices, billingUsage, shipmentEvidence] = await Promise.all([
    db
      .select({
        packageId: packagesTable.id,
        name: packagesTable.name,
        packageCode: packagesTable.packageCode,
        source: packagesTable.source,
        length: packagesTable.length,
        width: packagesTable.width,
        height: packagesTable.height,
        unitCost: packagesTable.unitCost,
      })
      .from(packagesTable)
      .where(eq(packagesTable.source, 'custom'))
      .orderBy(asc(packagesTable.name)),
    db
      .select({
        packageId: clientPackagePrices.packageId,
        price: clientPackagePrices.price,
        isCustom: clientPackagePrices.isCustom,
      })
      .from(clientPackagePrices)
      .where(eq(clientPackagePrices.clientId, clientId)),
    db
      .selectDistinct({ packageId: billingLineItems.packageId })
      .from(billingLineItems)
      .where(
        and(
          eq(billingLineItems.clientId, clientId),
          sql`${billingLineItems.packageId} is not null`,
        ),
      ),
    db
      .selectDistinct({
        selectedPid: shipments.selectedPid,
        selectedPackageId: shipments.selectedPackageId,
        dimsL: shipments.dimsL,
        dimsW: shipments.dimsW,
        dimsH: shipments.dimsH,
      })
      .from(shipments)
      .where(
        and(
          eq(shipments.clientId, clientId),
          eq(shipments.voided, false),
        ),
      ),
  ]);

  return buildClientUsedPackagePricingRows({
    packages: packageRows,
    savedPrices,
    billingPackageIds: billingUsage.map((row) => row.packageId),
    shipmentEvidence,
  });
}
