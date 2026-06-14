/**
 * PS-224 — negative-stock correction PROPOSAL core (pure, no IO).
 *
 * A SKU that was auto-deducted before it was ever received goes negative
 * (fulfillment-deductions.ts auto-creates the row at stock_qty 0, then
 * 0 - shipped < 0). This computes a PROPOSED corrective ledger entry to lift the
 * cached stock_qty back to a non-negative floor — it never applies anything.
 *
 * Two shapes:
 *   • baseline_receive — the ledger truth (effectiveStock) is ALSO negative and
 *     equals the cache: the SKU is genuinely missing a receive baseline. Propose
 *     a 'receive' to floor at 0 (DJ then adjusts to the real on-hand).
 *   • cache_correction — the cache drifted from the ledger truth: propose an
 *     'adjust' to set the cache to the ledger value (or 0 floor if that is also
 *     negative).
 *
 * Every proposal carries safeToAutoRepair:false — these are reviewed, never
 * auto-applied (matches the inventory reconciliation read-only posture).
 */
export interface NegativeStockInput {
  inventoryId: number;
  sku: string;
  clientId: number | null;
  cacheStockQty: number;
  effectiveStock: number;
  totalReceived: number;
  totalSold: number;
}

export interface NegativeStockProposal extends NegativeStockInput {
  proposalType: 'baseline_receive' | 'cache_correction';
  proposedLedgerType: 'receive' | 'adjust';
  proposedDelta: number; // positive units to add
  resultingStockQty: number;
  safeToAutoRepair: false;
}

export function proposeNegativeStockCorrection(row: NegativeStockInput): NegativeStockProposal {
  // The ledger and cache agree (both negative) → a real receive baseline is missing.
  const cacheMatchesLedger = row.cacheStockQty === row.effectiveStock;
  const proposalType = cacheMatchesLedger ? 'baseline_receive' : 'cache_correction';

  // Target: lift to the ledger truth when that is non-negative, else floor at 0.
  const target = proposalType === 'cache_correction' && row.effectiveStock >= 0
    ? row.effectiveStock
    : 0;
  const proposedDelta = Math.max(0, target - row.cacheStockQty);

  return {
    ...row,
    proposalType,
    proposedLedgerType: proposalType === 'baseline_receive' ? 'receive' : 'adjust',
    proposedDelta,
    resultingStockQty: row.cacheStockQty + proposedDelta,
    safeToAutoRepair: false,
  };
}
