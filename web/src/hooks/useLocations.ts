import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  SHARED_DATA_STALE_MS,
  SHARED_DATA_CACHE_MS,
  type SharedDataHookOptions,
} from './v2Hooks-shared';

// ──────────────────────────────────────────────────────────────────
// useLocations — v4 returns rows with `id`; adapt to `locationId`.
// ──────────────────────────────────────────────────────────────────

export interface LocationDto {
  locationId: number;
  name: string;
  company: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefault: boolean;
  active: boolean;
}

export interface UseLocationsResult {
  locations: LocationDto[];
  isLoading: boolean;
  error: Error | null;
}

type V4LocationRow = {
  id: number;
  name: string;
  company: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefault: boolean;
  active: boolean;
};

export function useLocations(options: SharedDataHookOptions = {}): UseLocationsResult {
  const enabled = options.enabled ?? true;
  const query = useQuery<V4LocationRow[]>({
    queryKey: ['v2-hooks:locations'],
    queryFn: () => api.get<V4LocationRow[]>('/locations'),
    enabled,
    staleTime: SHARED_DATA_STALE_MS,
    gcTime: SHARED_DATA_CACHE_MS,
    refetchOnWindowFocus: false,
  });

  const locations = useMemo<LocationDto[]>(
    () =>
      (query.data ?? []).map((row) => ({
        locationId: row.id,
        name: row.name,
        company: row.company,
        street1: row.street1,
        street2: row.street2,
        city: row.city,
        state: row.state,
        postalCode: row.postalCode,
        country: row.country,
        phone: row.phone,
        isDefault: row.isDefault,
        active: row.active,
      })),
    [query.data]
  );

  return {
    locations,
    isLoading: enabled && query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
