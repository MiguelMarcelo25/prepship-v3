import { db } from '../db/client';
import { packages } from '../db/schema/packages';
import type { NewPackage } from '../db/schema/packages';
import {
  STANDARD_PACKAGE_DIMENSIONS,
  STANDARD_PACKAGE_DIMENSIONS_PARSE_RESULT,
  type PackageDimension,
} from '../lib/standard-package-dimensions';

export interface PackageDimensionImportResult {
  inserted: number;
  skippedExisting: number;
  skippedInvalid: number;
  skippedDuplicates: number;
  totalValid: number;
  rawLineCount: number;
}

const DIMENSION_TOLERANCE = 0.1;

function hasMatchingDimensions(
  existingPackages: Array<{ length: number; width: number; height: number }>,
  dimension: PackageDimension
) {
  return existingPackages.some(
    (pkg) =>
      Math.abs(pkg.length - dimension.length) <= DIMENSION_TOLERANCE &&
      Math.abs(pkg.width - dimension.width) <= DIMENSION_TOLERANCE &&
      Math.abs(pkg.height - dimension.height) <= DIMENSION_TOLERANCE
  );
}

export async function importStandardPackageDimensions(): Promise<PackageDimensionImportResult> {
  let skippedExisting = 0;
  const existingPackages = await db
    .select({
      length: packages.length,
      width: packages.width,
      height: packages.height,
    })
    .from(packages);
  const rowsToInsert: NewPackage[] = [];

  for (const dimension of STANDARD_PACKAGE_DIMENSIONS) {
    if (hasMatchingDimensions(existingPackages, dimension)) {
      skippedExisting += 1;
      continue;
    }

    rowsToInsert.push({
      name: `Custom ${dimension.label}`,
      type: 'box',
      length: dimension.length,
      width: dimension.width,
      height: dimension.height,
      tareWeightOz: 0,
      source: 'custom',
      stockQty: 0,
      reorderLevel: 10,
    });
  }

  if (rowsToInsert.length > 0) {
    await db.insert(packages).values(rowsToInsert);
  }

  return {
    inserted: rowsToInsert.length,
    skippedExisting,
    skippedInvalid: STANDARD_PACKAGE_DIMENSIONS_PARSE_RESULT.skippedLines.length,
    skippedDuplicates: STANDARD_PACKAGE_DIMENSIONS_PARSE_RESULT.duplicateCount,
    totalValid: STANDARD_PACKAGE_DIMENSIONS.length,
    rawLineCount: STANDARD_PACKAGE_DIMENSIONS_PARSE_RESULT.rawLineCount,
  };
}
