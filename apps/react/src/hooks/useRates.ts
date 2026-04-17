import { useState, useCallback } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const SESSION_TOKEN = import.meta.env.VITE_SESSION_TOKEN || "";

export interface RateDims {
  length: number;
  width: number;
  height: number;
}

export interface RateResult {
  carrier: string;
  service: string;
  price: number;
  serviceId?: string;
  accountId?: number;
  carrierCode?: string;
  serviceCode?: string;
  deliveryDays?: number;
  serviceName?: string;
  shipmentCost?: number;
  otherCost?: number;
  shippingProviderId?: number;
}

export interface UseRatesResult {
  rates: RateResult[];
  loading: boolean;
  error: Error | null;
  fetchRates: (
    storeId: string | number | null,
    toZip: string,
    weight: number,
    dims: { w: number; h: number; d: number } | null,
    insurance?: boolean,
    residential?: boolean
  ) => Promise<RateResult[]>;
  clearRates: () => void;
}

export function useRates(): UseRatesResult {
  const [rates, setRates] = useState<RateResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchRates = useCallback(
    async (
      storeId: string | number | null,
      toZip: string,
      weight: number,
      dims: { w: number; h: number; d: number } | null,
      insurance?: boolean,
      residential?: boolean
    ): Promise<RateResult[]> => {
      if (!toZip || !weight) {
        setRates([]);
        return [];
      }

      setLoading(true);
      setError(null);

      try {
        const payload: Record<string, unknown> = {
          toPostalCode: toZip,
          toCountry: "US",
          weight: {
            value: weight,
            units: "ounces",
          },
          residential: residential ?? false,
        };
        if (storeId) payload.storeId = storeId;
        if (dims) {
          payload.dimensions = {
            units: "inches",
            width: dims.w,
            height: dims.h,
            length: dims.d,
          };
        }

        const response = await fetch(`${API_BASE}/api/rates`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(SESSION_TOKEN ? { "X-App-Token": SESSION_TOKEN } : {}),
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`Rate fetch failed: ${response.statusText}`);
        }

        const data = await response.json();
        // API returns { rates: [...] } or just an array
        const rawRates: any[] = Array.isArray(data) ? data : data.rates || [];

        const normalized: RateResult[] = rawRates.map((r: any) => ({
          carrier: r.carrier || r.carrierCode || "",
          service: r.service || r.serviceName || r.serviceCode || "",
          price: r.price ?? ((r.shipmentCost ?? 0) + (r.otherCost ?? 0)),
          serviceId: r.serviceId || r.serviceCode,
          accountId: r.accountId || r.shippingProviderId,
          carrierCode: r.carrierCode || r.carrier,
          serviceCode: r.serviceCode || r.serviceId,
          deliveryDays: r.deliveryDays,
          serviceName: r.serviceName || r.service,
          shipmentCost: r.shipmentCost,
          otherCost: r.otherCost,
          shippingProviderId: r.shippingProviderId || r.accountId,
        }));

        setRates(normalized);
        return normalized;
      } catch (err) {
        const error = err instanceof Error ? err : new Error("Failed to fetch rates");
        setError(error);
        console.error("[useRates]", error);
        return [];
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const clearRates = useCallback(() => {
    setRates([]);
    setError(null);
  }, []);

  return { rates, loading, error, fetchRates, clearRates };
}
