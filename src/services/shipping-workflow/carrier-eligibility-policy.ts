// PS-106 slice 2 — carrier-family eligibility POLICY (settings-backed, audit-first).
//
// Per user override unlock shipped data on 2026-06-06.
//
// Wires the pure primitive to a server-side setting and the purchase boundary, with
// a SAFE-BY-DEFAULT `audit_only` rollout: would-block decisions are LOGGED (sanitized)
// but NOT blocked until an operator explicitly sets the policy to `enforce`. This is
// the inverse risk profile of PS-105 — enforcing too early could wrongly block a
// legitimate ShipStation purchase, so we observe real traffic first.
//
// Source signal: orders.sourceProvider / raw. This repo has no separate store-connector
// table, so this is the best available signal; before flipping to `enforce`, the
// classifier should be validated against live audit logs (and tightened to the
// authoritative connector model if/when one is added). Audit_only never blocks, so
// using the best signal to REPORT is safe.

import { getSetting } from '../settings';
import {
  classifyOrderSource,
  evaluateCarrierFamilyEligibility,
  CARRIER_ELIGIBILITY_BLOCK_MESSAGE,
  type CarrierEligibilityMode,
  type CarrierFamily,
} from './carrier-family-eligibility';

export const CARRIER_ELIGIBILITY_SETTING_KEY = 'block_shipstation_for_direct_store';

/** Read the policy mode. Default is the SAFE `audit_only` (report, never block). */
export async function getCarrierEligibilityMode(): Promise<CarrierEligibilityMode> {
  const raw = (await getSetting(CARRIER_ELIGIBILITY_SETTING_KEY))?.trim().toLowerCase();
  if (raw === 'enforce' || raw === 'disabled' || raw === 'audit_only') return raw;
  return 'audit_only';
}

export class CarrierFamilyEligibilityError extends Error {
  code = 'CARRIER_FAMILY_NOT_ELIGIBLE';
  ruleId?: string;
  constructor(message: string, ruleId?: string) {
    super(message);
    this.name = 'CarrierFamilyEligibilityError';
    this.ruleId = ruleId;
  }
}

function rawSourceText(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const v = r.source_provider ?? r.sourceProvider ?? r.source ?? r.provider ?? r.marketplace ?? r.platform;
  return typeof v === 'string' ? v : null;
}

/**
 * Enforce (or audit) the carrier-family rule before a real provider purchase.
 *   - audit_only / disabled: logs a sanitized would-block warning, NEVER throws.
 *   - enforce: throws CarrierFamilyEligibilityError (blocks) for an ineligible
 *     ShipStation purchase on a direct-store / unknown-source order.
 * Direct/native carriers are always allowed, so this only ever affects ShipStation.
 */
export async function assertCarrierFamilyEligibleForPurchase(input: {
  carrierFamily: CarrierFamily;
  order: { sourceProvider?: string | null; raw?: unknown };
  orderId: number | string;
  /** Test-only override so callers/guards can exercise enforce/audit without the DB. */
  modeOverride?: CarrierEligibilityMode;
}): Promise<void> {
  const mode = input.modeOverride ?? await getCarrierEligibilityMode();
  const orderSource = classifyOrderSource({
    sourceProvider: input.order.sourceProvider ?? null,
    rawSource: rawSourceText(input.order.raw),
  });
  const result = evaluateCarrierFamilyEligibility({
    orderSource,
    carrierFamily: input.carrierFamily,
    mode,
  });
  if (!result.wouldBlock) return;
  if (result.allowed) {
    // audit_only / disabled — report only. No order PII; just ids/rule/source.
    console.warn(
      `[carrier-eligibility] AUDIT would-block: order=${input.orderId} source=${orderSource} family=${input.carrierFamily} rule=${result.ruleId} mode=${mode}`,
    );
    return;
  }
  // enforce — block before the provider call.
  throw new CarrierFamilyEligibilityError(CARRIER_ELIGIBILITY_BLOCK_MESSAGE, result.ruleId);
}
