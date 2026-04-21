// @ts-nocheck
import { useEffect, useState } from "react";
import { apiClient } from "../api/client";
import type { CarrierAccountDto } from "../types/api";

export interface UseShippingAccountsResult {
  accounts: CarrierAccountDto[];
  isLoading: boolean;
  error: Error | null;
}

export function useShippingAccounts(): UseShippingAccountsResult {
  const [accounts, setAccounts] = useState<CarrierAccountDto[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    setError(null);

    void apiClient.fetchCarrierAccounts()
      .then((payload) => {
        if (!mounted) return;
        setAccounts(payload);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err : new Error("Failed to fetch shipping accounts"));
      })
      .finally(() => {
        if (!mounted) return;
        setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  return { accounts, isLoading, error };
}
