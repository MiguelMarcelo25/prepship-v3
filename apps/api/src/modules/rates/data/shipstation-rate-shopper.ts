import type { CarrierAccountDto } from "../../../../../../../packages/contracts/src/init/contracts.js";
import type { RateDto } from "../../../../../../../packages/contracts/src/rates/contracts.js";
import { BLOCKED_CARRIER_IDS, CARRIER_ACCOUNTS_V2 } from "../../../common/prepship-config.js";
import type { LiveRateShopRequest, RateShopper } from "../application/rate-shopper.js";
import { getShipStationClient } from "../../../common/shipstation/client.js";

const FROM_ZIP = "90248";

const ZIP_LOOKUP: Record<string, { city: string; state: string }> = {
  "02": { city: "Boston", state: "MA" },
  "10": { city: "New York", state: "NY" },
  "30": { city: "Atlanta", state: "GA" },
  "33": { city: "Miami", state: "FL" },
  "60": { city: "Chicago", state: "IL" },
  "75": { city: "Dallas", state: "TX" },
  "77": { city: "Houston", state: "TX" },
  "85": { city: "Phoenix", state: "AZ" },
  "90": { city: "Los Angeles", state: "CA" },
  "92": { city: "San Diego", state: "CA" },
  "98": { city: "Seattle", state: "WA" },
};

function inferCarrierCode(account: CarrierAccountDto, serviceCode: string | null | undefined): string {
  if (account.carrierCode !== "unknown") {
    return account.carrierCode;
  }
  const service = serviceCode ?? "";
  if (service.startsWith("usps_")) return "stamps_com";
  if (service.startsWith("ups_")) return "ups";
  if (service.startsWith("fedex_")) return "fedex";
  return account.carrierCode;
}

async function discoverCarriers(apiKeyV2: string): Promise<CarrierAccountDto[]> {
  const client = getShipStationClient();
  try {
    const payload = await client.v2<{ carriers?: Array<{ carrier_id: string; name?: string }> }>(
      { apiKeyV2 },
      "/carriers",
      { deduplicate: true },
    );
    const discovered = (payload.carriers ?? []).map((carrier) => {
      const shippingProviderId = Number.parseInt(carrier.carrier_id.replace(/^se-/, ""), 10);
      const known = CARRIER_ACCOUNTS_V2.find((entry) => entry.shippingProviderId === shippingProviderId);
      if (known) return known;
      const code = (carrier.name ?? "unknown").toLowerCase().replace(/\s+/g, "_");
      return {
        carrierId: carrier.carrier_id,
        carrierCode: code,
        shippingProviderId,
        nickname: carrier.name ?? carrier.carrier_id,
        clientId: null,
        code,
        _label: carrier.name ?? carrier.carrier_id,
      };
    });
    return discovered.length > 0 ? discovered : CARRIER_ACCOUNTS_V2;
  } catch {
    return CARRIER_ACCOUNTS_V2;
  }
}

async function fetchRatesForCarrier(account: CarrierAccountDto, request: LiveRateShopRequest): Promise<RateDto[]> {
  const client = getShipStationClient();
  const zipGeo = ZIP_LOOKUP[request.toZip.slice(0, 2)] ?? { city: "City", state: "NY" };
  const needsCity = account.carrierCode === "stamps_com";
  const body = {
    carrier_ids: [account.carrierId],
    from_country_code: "US",
    from_postal_code: FROM_ZIP,
    to_country_code: "US",
    to_postal_code: request.toZip,
    ...(needsCity ? { to_city_locality: zipGeo.city, to_state_province: zipGeo.state } : {}),
    weight: { value: request.weightOz, unit: "ounce" },
    address_residential_indicator: request.residential ? "yes" : "no",
    ship_date: new Date().toISOString(),
    ...(request.dims ? { dimensions: { ...request.dims, unit: "inch" } } : {}),
    ...(request.signature && request.signature !== "none" ? { signature_option: request.signature } : {}),
  };

  const isDebugSignature = request.signature && request.signature !== "none";
  if (isDebugSignature) {
    console.log(`[RateShopper] Fetching rates for ${account.nickname} with signature=${request.signature}. Body:`, JSON.stringify(body, null, 2));
  }

  try {
    const payload = await client.v2<Array<Record<string, unknown>> | { rates?: Array<Record<string, unknown>> }>(
      { apiKeyV2: request.apiKeyV2 as string },
      "/rates/estimate",
      { method: "POST", body },
    );

    const rates = Array.isArray(payload) ? payload : (payload.rates ?? []);

    if (isDebugSignature) {
      console.log(`[RateShopper] Response for ${account.nickname} (signature=${request.signature}): ${rates.length} rates found.`);
    }

    return rates.map((rate) => ({
      serviceCode: String(rate.service_code ?? ""),
      serviceName: String(rate.service_type ?? rate.service_code ?? ""),
      packageType: rate.package_type ? String(rate.package_type) : null,
      shipmentCost: Number((rate.shipping_amount as { amount?: number } | undefined)?.amount ?? 0),
      otherCost: Number((rate.other_amount as { amount?: number } | undefined)?.amount ?? 0),
      rateDetails: Array.isArray(rate.rate_details) ? rate.rate_details : [],
      carrierCode: inferCarrierCode(account, String(rate.service_code ?? "")),
      shippingProviderId: account.shippingProviderId,
      carrierNickname: account.nickname,
      guaranteed: Boolean(rate.guaranteed_service),
      zone: rate.zone ? String(rate.zone) : null,
      sourceClientId: request.sourceClientId,
      deliveryDays: rate.delivery_days != null ? Number(rate.delivery_days) : null,
      estimatedDelivery: rate.estimated_delivery_date ? String(rate.estimated_delivery_date) : null,
    }));
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (isDebugSignature || msg.includes("401") || msg.includes("429")) {
      console.error(`[RateShopper] ShipStation API error for ${account.nickname}: ${msg}`);
    }
    return [];
  }
}

export class ShipstationRateShopper implements RateShopper {
  async fetchRates(request: LiveRateShopRequest): Promise<RateDto[]> {
    if (!request.apiKeyV2) {
      return [];
    }

    const carriers = (await discoverCarriers(request.apiKeyV2 as string)).filter((carrier) =>
      carrier.carrierCode &&
      carrier.carrierCode !== "unknown" &&
      !BLOCKED_CARRIER_IDS.has(carrier.shippingProviderId),
    );
    const batches = await Promise.all(carriers.map((carrier) => fetchRatesForCarrier(carrier, request)));
    return batches.flat().sort((left, right) =>
      (left.shipmentCost + left.otherCost) - (right.shipmentCost + right.otherCost),
    );
  }
}
