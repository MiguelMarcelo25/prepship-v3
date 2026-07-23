import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';
import { endpointQueryKeys } from '../lib/endpoint-query-keys';
import {
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

export function useLocations(options: SharedDataHookOptions = {}): UseLocationsResult {
  const enabled = options.enabled ?? true;
  const query = useQuery<LocationDto[]>({
    queryKey: endpointQueryKeys.locations,
    queryFn: () => apiClient.fetchLocations(),
    enabled,
  });

  return {
    locations: query.data ?? [],
    isLoading: enabled && query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
