/**
 * carrier-resolver.ts — single source of truth for carrier nickname resolution.
 *
 * Imported by list-orders.ts and order-details.ts.
 * Do NOT duplicate this function in those files.
 *
 * Resolution order:
 *   1. providerAccountId exact match → nickname
 *   2. UPS 1Z tracking decode: chars 3-8 = UPS account code → match accountNumber
 *   3. Only one account for carrierCode → that account's nickname
 *   4. Human-readable carrier name fallback
 *
 * To add/change carrier accounts: update CARRIER_ACCOUNTS_V2 in prepship-config.ts only.
 */

import { CARRIER_ACCOUNTS_V2 } from "../../../common/prepship-config.js";

const CARRIER_DISPLAY_NAMES: Record<string, string> = {
  stamps_com: "USPS",
  ups: "UPS",
  ups_walleted: "UPS",
  fedex: "FedEx",
  fedex_walleted: "FedEx One Balance",
  dhl_express: "DHL Express",
  amazon_buy_shipping: "Amazon",
  amazon_shipping_us: "Amazon",
  sendle: "Sendle",
  tusk: "Tusk",
};

export function resolveCarrierNickname(
  providerAccountId: number | null,
  carrierCode: string | null,
  trackingNumber?: string | null,
  clientId?: number | null,
): string | null {
  if (!carrierCode) return null;

  // 1. Exact match by providerAccountId (set when PrepShip creates the label)
  if (providerAccountId) {
    const exact = CARRIER_ACCOUNTS_V2.find((a) => a.shippingProviderId === providerAccountId);
    if (exact) return exact.nickname;
  }

  // 2. UPS: decode account code from tracking number
  //    Format: 1Z [acct:6] [service:2] [seq:8] [check:1]
  if ((carrierCode === "ups" || carrierCode === "ups_walleted") && trackingNumber) {
    const tn = trackingNumber.replace(/\s/g, "").toUpperCase();
    if (tn.startsWith("1Z") && tn.length >= 8) {
      const acctCode = tn.slice(2, 8);
      const matched = CARRIER_ACCOUNTS_V2.find(
        (a) =>
          (a.carrierCode === "ups" || a.carrierCode === "ups_walleted") &&
          a.accountNumber?.toUpperCase() === acctCode,
      );
      if (matched) return matched.nickname;
    }
  }

  // 3. Filter by carrierCode, then narrow by clientId if provided
  const matching = CARRIER_ACCOUNTS_V2.filter((a) => a.carrierCode === carrierCode);
  if (matching.length === 1) return matching[0]!.nickname;

  // 3b. Multiple accounts — try to narrow by clientId
  //     clientId=null means "shared/main account"; use that as default for real client orders
  if (matching.length > 1 && clientId !== undefined && clientId !== null) {
    // Try exact clientId match first
    const clientMatch = matching.find((a) => a.clientId === clientId);
    if (clientMatch) return clientMatch.nickname;
    // Fall back to the shared account (clientId=null)
    const sharedMatch = matching.find((a) => a.clientId === null);
    if (sharedMatch) return sharedMatch.nickname;
  }
  if (matching.length > 1) {
    // No clientId context — use shared account
    const sharedMatch = matching.find((a) => a.clientId === null);
    if (sharedMatch) return sharedMatch.nickname;
  }

  // 4. Human-readable fallback
  return CARRIER_DISPLAY_NAMES[carrierCode] ?? carrierCode.replace(/_/g, " ").toUpperCase();
}
