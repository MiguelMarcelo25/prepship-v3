// @ts-nocheck
/**
 * StoresContext — Global store/client selection
 * 
 * Provides selected store context across the app
 * Maps store -> client_id for API calls
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import { apiClient } from '../api/client'
import type { ClientDto } from '@prepshipv2/contracts/clients/contracts'

export interface StoresContextValue {
  stores: ClientDto[]
  selectedStoreId: number | null
  selectedStore: ClientDto | null
  setSelectedStoreId: (id: number) => void
  loading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

const StoresContext = createContext<StoresContextValue | null>(null)

export function StoresProvider({ children }: { children: ReactNode }) {
  const [stores, setStores] = useState<ClientDto[]>([])
  const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  // Fetch stores on mount
  const fetchStores = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiClient.listClients()
      setStores(data)
      // Auto-select first store if none selected
      if (data.length > 0 && !selectedStoreId) {
        setSelectedStoreId(data[0].clientId)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to fetch stores')
      setError(error)
      console.error('[StoresContext]', error)
    } finally {
      setLoading(false)
    }
  }, [selectedStoreId])

  useEffect(() => {
    void fetchStores()
  }, [fetchStores])

  const selectedStore = stores.find(s => s.clientId === selectedStoreId) || null

  return (
    <StoresContext.Provider
      value={{
        stores,
        selectedStoreId,
        selectedStore,
        setSelectedStoreId,
        loading,
        error,
        refetch: fetchStores,
      }}
    >
      {children}
    </StoresContext.Provider>
  )
}

export function useStores(): StoresContextValue {
  const ctx = useContext(StoresContext)
  if (!ctx) throw new Error('useStores must be used within StoresProvider')
  return ctx
}
