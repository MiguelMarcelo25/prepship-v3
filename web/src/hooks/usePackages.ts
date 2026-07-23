import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';
import { endpointQueryKeys } from '../lib/endpoint-query-keys';

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

export function usePackages(): UsePackagesResult {
  const query = useQuery<PackageDto[]>({
    queryKey: endpointQueryKeys.packages(),
    queryFn: () => apiClient.fetchPackages(),
  });

  return {
    packages: query.data ?? [],
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    refetch: () => query.refetch(),
  };
}
