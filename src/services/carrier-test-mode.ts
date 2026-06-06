// Carrier test-mode seam — Slice 1 scaffold.
// Plan: ~/.claude/plans/zany-spinning-hennessy.md (E2E carrier shipping test harness).
//
// PURPOSE
// Give the 4 direct-carrier providers (easypost/shipp/ups/walmart_shipping) a
// SAFE test path — real-carrier-equivalent label creation that never spends money
// and never notifies a marketplace — by wrapping the single createLabel call in
// carrier-connector-orchestrator.ts. This is the ONLY seam; no per-provider branch
// in api/carriers/labels.ts is touched, so the production purchase path is unchanged.
//
// SAFETY — double gate
// isCarrierTestMode() is true ONLY when BOTH:
//   1. process.env.CARRIER_TEST_MODE is set (arms the feature in a test process), AND
//   2. the per-call input carries __carrierTestMode === true (selects it for THIS call).
// Production callers never set the per-call flag, so this entire module is a dead
// branch in production. The orchestrator's non-test path stays byte-identical.
//
// This module is a LEAF (imports only types) so it is cold-start safe on Vercel,
// mirroring src/lib/direct-carrier-scope.ts.

import type { CarrierLabelInput, NormalizedCarrierLabelResult } from '../connectors/types.js';

export type CarrierTestStrategy = 'sandbox' | 'replay';

// Sources that represent a real upstream marketplace. A test run must never carry
// one of these — the order must be internal/test so no confirmation can fire.
const REAL_MARKETPLACE_SOURCES = new Set(['walmart', 'ebay', 'amazon', 'shipstation']);

function record(input: CarrierLabelInput): Record<string, any> {
  return input && typeof input === 'object' ? (input as Record<string, any>) : {};
}

function providerKey(provider: string | null | undefined): string {
  return String(provider ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** Double gate: env arms the feature, the per-call flag selects it. */
export function isCarrierTestMode(input: CarrierLabelInput): boolean {
  if (!process.env.CARRIER_TEST_MODE) return false;
  return record(input).__carrierTestMode === true;
}

/**
 * Which fidelity tier to use for a provider:
 *   - easypost → 'sandbox' (real HTTP with a TEST api key; non-deliverable $0 labels)
 *   - everyone else → 'replay' (recorded real responses through the real parser)
 * Overridable via CARRIER_TEST_STRATEGY (JSON map provider→strategy) for capture/dev.
 */
export function resolveCarrierTestStrategy(provider: string | null | undefined): CarrierTestStrategy {
  const key = providerKey(provider);
  const override = readStrategyOverride();
  if (override[key]) return override[key];
  return key === 'easypost' ? 'sandbox' : 'replay';
}

function readStrategyOverride(): Record<string, CarrierTestStrategy> {
  const raw = process.env.CARRIER_TEST_STRATEGY;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, CarrierTestStrategy> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === 'sandbox' || v === 'replay') out[k.toLowerCase()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export class CarrierTestModeSafetyError extends Error {
  code = 'CARRIER_TEST_MODE_UNSAFE';
  constructor(message: string) {
    super(message);
    this.name = 'CarrierTestModeSafetyError';
  }
}

/**
 * Hard stop before any provider call in test mode. Refuses to proceed if the run
 * could possibly cost money or notify a marketplace:
 *   - any strategy: order source must NOT be a real marketplace (must be internal/test).
 *   - sandbox(easypost): the api key MUST be a TEST key (EZTK…), never a live key (EZAK…).
 * Replay never performs real HTTP, so it is inherently $0; the marketplace check still applies.
 */
export function assertNoLivePostageOrMarketplace(
  provider: string | null | undefined,
  input: CarrierLabelInput,
  strategy: CarrierTestStrategy,
): void {
  const row = record(input);
  const source = String(row.__sourceProvider ?? '').trim().toLowerCase();
  if (REAL_MARKETPLACE_SOURCES.has(source)) {
    throw new CarrierTestModeSafetyError(
      `carrier test mode refused: order source "${source}" is a real marketplace; use an internal/test order`,
    );
  }
  if (strategy === 'sandbox' && providerKey(provider) === 'easypost') {
    const creds =
      row.credentials && typeof row.credentials === 'object' ? (row.credentials as Record<string, any>) : {};
    const apiKey = String(creds.apiKey ?? creds.api_key ?? creds.testApiKey ?? '').trim();
    if (!/^EZTK/i.test(apiKey)) {
      throw new CarrierTestModeSafetyError(
        'carrier test mode refused: EasyPost sandbox requires a TEST api key (EZTK…); refusing to use a live key',
      );
    }
  }
}

/**
 * Run a recorded provider response through the connector's REAL request-build +
 * response-parse path (so the parser/normalizer is genuinely exercised, not bypassed).
 * Wired in Slice 3 (timedFetch replay hook + recorded fixtures). Until then this is
 * unreachable in practice (double gate keeps the whole module inert in production,
 * and Slice 2 exercises only the sandbox tier).
 */
export async function replayCarrierLabel(
  _provider: string | null | undefined,
  _input: CarrierLabelInput,
): Promise<NormalizedCarrierLabelResult> {
  throw new Error('carrier test mode: replay strategy is not wired until Slice 3');
}
