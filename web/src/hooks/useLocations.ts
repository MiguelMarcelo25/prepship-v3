// @ts-nocheck
import { useEffect, useState } from "react";
import { apiClient } from "../api/client";
import type { LocationDto } from "../types/api";

export interface UseLocationsResult {
  locations: LocationDto[];
  isLoading: boolean;
  error: Error | null;
}

export function useLocations(): UseLocationsResult {
  const [locations, setLocations] = useState<LocationDto[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    setError(null);

    void apiClient.fetchLocations()
      .then((payload) => {
        if (!mounted) return;
        setLocations(payload);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err : new Error("Failed to fetch locations"));
      })
      .finally(() => {
        if (!mounted) return;
        setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  return { locations, isLoading, error };
}
