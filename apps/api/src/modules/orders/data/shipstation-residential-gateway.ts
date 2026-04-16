import type { TransitionalSecrets } from "../../../../../../../packages/shared/src/config/secrets-adapter.js";

export interface ResidentialLookupResult {
  orderId: number;
  residential: boolean | null;
}

/**
 * ShipstationResidentialGateway queries ShipStation API for address residential/commercial status.
 * This is used to determine the correct shipping rates (residential vs commercial have different pricing).
 * 
 * Why this matters: If we guess "residential" wrong, we fetch the wrong rates and show incorrect pricing.
 */
export class ShipstationResidentialGateway {
  private readonly authHeader: string;
  private readonly baseUrl = "https://ssapi.shipstation.com";

  constructor(secrets: TransitionalSecrets) {
    const apiKey = secrets.shipstation?.api_key;
    const apiSecret = secrets.shipstation?.api_secret;
    if (!apiKey || !apiSecret) {
      throw new Error("ShipStation API credentials required for residential lookup");
    }
    this.authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  }

  /**
   * Lookup residential status for orders.
   * Queries ShipStation API with a strict timeout to avoid blocking order responses.
   * 
   * Returns:
   * - true = residential address
   * - false = commercial address
   * - null = unable to determine or API timeout (use fallback logic)
   */
  async lookupResidential(
    shipStationOrderIds: Array<{ orderId: number; shipStationOrderNumber: string | null }>,
  ): Promise<ResidentialLookupResult[]> {
    // If no ShipStation order numbers, return nulls
    if (!shipStationOrderIds.length) {
      return shipStationOrderIds.map((item) => ({ orderId: item.orderId, residential: null }));
    }

    const results = new Map<number, boolean | null>();

    // Initialize all as null (couldn't determine)
    for (const item of shipStationOrderIds) {
      results.set(item.orderId, null);
    }

    try {
      const shipStationNumbers = new Set(
        shipStationOrderIds
          .filter((item) => item.shipStationOrderNumber)
          .map((item) => item.shipStationOrderNumber as string),
      );

      if (shipStationNumbers.size === 0) {
        // No ShipStation order numbers to look up; return all nulls
        return Array.from(results.entries()).map(([orderId, residential]) => ({
          orderId,
          residential,
        }));
      }

      // Build a map of ShipStation order number → prepship order ID for fast lookup
      const ssNumberToOrderId = new Map(
        shipStationOrderIds.map((item) => [item.shipStationOrderNumber, item.orderId]),
      );

      // Query ShipStation for orders with a strict timeout (5 seconds total)
      // Only fetch the first page to avoid long pagination delays
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(
          `${this.baseUrl}/orders?pageSize=100&page=1`,
          {
            method: "GET",
            headers: { Authorization: this.authHeader },
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          console.warn(
            `ShipStation residential lookup failed: ${response.status}. Using fallback logic.`,
          );
          // Return nulls to fall back to company-based heuristic
          return Array.from(results.entries()).map(([orderId, residential]) => ({
            orderId,
            residential,
          }));
        }

        const data = (await response.json()) as any;
        if (!data.orders || !Array.isArray(data.orders)) {
          // Return nulls if response format is unexpected
          return Array.from(results.entries()).map(([orderId, residential]) => ({
            orderId,
            residential,
          }));
        }

        // Extract residential status for matching orders
        for (const ssOrder of data.orders) {
          const ssOrderNumber = ssOrder.orderNumber;
          const prepshipOrderId = ssNumberToOrderId.get(ssOrderNumber);

          if (prepshipOrderId) {
            // Extract residential status from shipTo object
            // ShipStation API returns { shipTo: { residential: true|false } }
            const ssResidential = ssOrder.shipTo?.residential;
            if (typeof ssResidential === "boolean") {
              results.set(prepshipOrderId, ssResidential);
            }
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      // On error or timeout, just return nulls (fall back to company-based heuristic)
      if (error instanceof Error && error.name === "AbortError") {
        console.warn("ShipStation residential lookup timed out. Using fallback logic.");
      } else {
        console.warn(`ShipStation residential gateway error: ${error}. Using fallback logic.`);
      }
    }

    return Array.from(results.entries()).map(([orderId, residential]) => ({
      orderId,
      residential,
    }));
  }
}
