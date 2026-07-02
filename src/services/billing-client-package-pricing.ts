import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { billingLineItems, clientPackagePrices } from '../db/schema/billing';
import { packages as packagesTable } from '../db/schema/packages';
import { shipments } from '../db/schema/shipments';
import {
  buildClientUsedPackagePricingRows,
  type ClientUsedPackagePricingRow,
} from './billing-client-used-package-pricing-rows';

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
