import { api } from './api'
import {
  SHARED_DATA_CACHE_MS,
  SHARED_DATA_STALE_MS,
  transformClientRowV4toV2,
  type ClientDto,
  type V4ClientFullRow,
} from '../hooks/v2Hooks-shared'

export const clientQueryKeys = {
  root: ['clients'] as const,
  active: ['clients', 'active-only'] as const,
  includeInactive: ['clients', 'include-inactive'] as const,
}

export function activeClientRowsQueryOptions() {
  return {
    queryKey: clientQueryKeys.active,
    queryFn: () => api.get<V4ClientFullRow[]>('/clients?activeOnly=true'),
    staleTime: SHARED_DATA_STALE_MS,
    gcTime: SHARED_DATA_CACHE_MS,
    refetchOnWindowFocus: false,
  }
}

export function includeInactiveClientRowsQueryOptions() {
  return {
    queryKey: clientQueryKeys.includeInactive,
    queryFn: () => api.get<V4ClientFullRow[]>('/clients?includeInactive=true'),
    staleTime: SHARED_DATA_STALE_MS,
    gcTime: SHARED_DATA_CACHE_MS,
    refetchOnWindowFocus: false,
  }
}

export function clientDtosFromRows(rows: V4ClientFullRow[]): ClientDto[] {
  const namesById = new Map<number, string>()
  for (const row of rows) namesById.set(row.id, row.name)
  return rows.map((row) => transformClientRowV4toV2(row, namesById))
}
