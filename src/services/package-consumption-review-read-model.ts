import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { packageConsumptionReviews } from '../db/schema/package-consumption-reviews';
import { ensurePackageConsumptionSchema } from './package-consumption-schema';

export const PACKAGE_CONSUMPTION_REVIEW_STATUSES = [
  'pending',
  'resolved',
  'voided',
] as const;

export type PackageConsumptionReviewStatus =
  (typeof PACKAGE_CONSUMPTION_REVIEW_STATUSES)[number];

export async function listPackageConsumptionReviews(options: {
  status?: PackageConsumptionReviewStatus;
  limit?: number;
} = {}) {
  await ensurePackageConsumptionSchema();
  const status = options.status ?? 'pending';
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 100), 500));
  const [rows, [summary]] = await Promise.all([
    db
      .select()
      .from(packageConsumptionReviews)
      .where(eq(packageConsumptionReviews.status, status))
      .orderBy(desc(packageConsumptionReviews.effectiveAt), desc(packageConsumptionReviews.id))
      .limit(limit),
    db
      .select({
        pending: sql<number>`count(*) filter (where ${packageConsumptionReviews.status} = 'pending')::int`,
        resolved: sql<number>`count(*) filter (where ${packageConsumptionReviews.status} = 'resolved')::int`,
        voided: sql<number>`count(*) filter (where ${packageConsumptionReviews.status} = 'voided')::int`,
      })
      .from(packageConsumptionReviews),
  ]);
  return {
    status,
    limit,
    summary: summary ?? { pending: 0, resolved: 0, voided: 0 },
    rows,
  };
}
