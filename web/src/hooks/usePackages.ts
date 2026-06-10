import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { SHARED_DATA_STALE_MS, SHARED_DATA_CACHE_MS } from './v2Hooks-shared';

// ──────────────────────────────────────────────────────────────────
// usePackages — v4 returns `id` and numeric `unitCost` as a string
// (pg `numeric` column). v2 wants `packageId` and a parsed float.
// ──────────────────────────────────────────────────────────────────

export interface PackageDto {
  packageId: number;
  name: string;
  type: string;
  length: number;
  width: number;
  height: number;
  tareWeightOz: number;
  source: string | null;
  carrierCode: string | null;
  stockQty: number | null;
  reorderLevel: number | null;
  unitCost: number | null;
  isDefault: boolean;
}

export interface UsePackagesResult {
  packages: PackageDto[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

type V4PackageRow = {
  id: number;
  name: string;
  type: string;
  length: number;
  width: number;
  height: number;
  tareWeightOz: number;
  source: string | null;
  carrierCode: string | null;
  stockQty: number;
  reorderLevel: number;
  unitCost: string | null;
  isDefault: boolean;
};

function parseUnitCost(v: string | null): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function transformPackageRowV4toV2(row: V4PackageRow): PackageDto {
  return {
    packageId: row.id,
    name: row.name,
    type: row.type,
    length: row.length,
    width: row.width,
    height: row.height,
    tareWeightOz: row.tareWeightOz,
    source: row.source,
    carrierCode: row.carrierCode,
    stockQty: row.stockQty,
    reorderLevel: row.reorderLevel,
    unitCost: parseUnitCost(row.unitCost),
    isDefault: row.isDefault,
  };
}

export function usePackages(): UsePackagesResult {
  const query = useQuery<V4PackageRow[]>({
    queryKey: ['v2-hooks:packages'],
    queryFn: () => api.get<V4PackageRow[]>('/packages'),
    staleTime: SHARED_DATA_STALE_MS,
    gcTime: SHARED_DATA_CACHE_MS,
    refetchOnWindowFocus: false,
  });

  const packages = useMemo(
    () => (query.data ?? []).map(transformPackageRowV4toV2),
    [query.data]
  );

  return {
    packages,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    refetch: () => query.refetch(),
  };
}
