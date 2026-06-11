import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { type OrderFullDto } from './v2Hooks-shared';

// ──────────────────────────────────────────────────────────────────
// useOrderDetail — v2 signature accepts a string id.
// ──────────────────────────────────────────────────────────────────

export interface UseOrderDetailResult {
  order: OrderFullDto | null;
  isLoading: boolean;
  error: Error | null;
}

export function useOrderDetail(
  orderId: string | null | undefined
): UseOrderDetailResult {
  const raw = orderId != null ? String(orderId).trim() : '';
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const enabled = Number.isFinite(parsed) && parsed > 0;

  const query = useQuery<OrderFullDto>({
    queryKey: ['v2-hooks:order-detail', parsed],
    queryFn: () => api.get<OrderFullDto>(`/orders/${parsed}/full`),
    enabled,
  });

  return {
    order: query.data ?? null,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
