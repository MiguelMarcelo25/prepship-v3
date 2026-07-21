import { QueryClient } from '@tanstack/react-query'

export const VIEW_QUERY_STALE_MS = 5 * 60_000
export const VIEW_QUERY_CACHE_MS = 30 * 60_000

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: VIEW_QUERY_STALE_MS,
      gcTime: VIEW_QUERY_CACHE_MS,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      retry: 1,
    },
  },
})

for (const root of ['dashboard', 'billing', 'analysis', 'settings']) {
  queryClient.setQueryDefaults([root], {
    staleTime: VIEW_QUERY_STALE_MS,
    gcTime: VIEW_QUERY_CACHE_MS,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  })
}
