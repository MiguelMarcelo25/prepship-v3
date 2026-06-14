/**
 * PS-224 — negative-stock reconciliation (READ-ONLY, PROPOSE-ONLY).
 *
 * Finds active inventory rows whose cached stock_qty is negative, computes the
 * true on-hand from the ledger via the CANONICAL owner (computeEffectiveStockForIds
 * in src/services/inventory-stock-math.ts — single source of truth, not a fork),
 * and PROPOSES a corrective ledger entry per row. It applies NOTHING: there is no
 * --apply flag and no INSERT/UPDATE/DELETE — every proposal is for DJ to review and
 * apply by hand (matches the existing inventory reconciliation read-only posture).
 *
 *   npx tsx scripts/ps-224-negative-stock-reconcile.ts [--client-id N] [--limit N] [--json]
 */
import { sql } from '../src/db/client';
import { computeEffectiveStockForIds } from '../src/services/inventory-stock-math';
import { proposeNegativeStockCorrection, type NegativeStockProposal } from '../src/lib/negative-stock-core';

function argNum(flag: string): number | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

async function main() {
  const clientId = argNum('--client-id');
  const limit = Math.max(1, Math.min(argNum('--limit') ?? 500, 5000));
  const asJson = process.argv.includes('--json');

  const negatives = clientId != null
    ? await sql<{ id: number; sku: string; client_id: number | null; stock_qty: number }[]>`
        select id, sku, client_id, stock_qty from inventory
        where active = true and stock_qty < 0 and client_id = ${clientId}
        order by stock_qty asc limit ${limit}`
    : await sql<{ id: number; sku: string; client_id: number | null; stock_qty: number }[]>`
        select id, sku, client_id, stock_qty from inventory
        where active = true and stock_qty < 0
        order by stock_qty asc limit ${limit}`;

  const ids = negatives.map((r) => r.id);
  const effective = await computeEffectiveStockForIds(ids);

  const proposals: NegativeStockProposal[] = negatives.map((r) => {
    const e = effective.get(r.id);
    return proposeNegativeStockCorrection({
      inventoryId: r.id,
      sku: r.sku,
      clientId: r.client_id,
      cacheStockQty: Number(r.stock_qty),
      effectiveStock: e ? Number(e.effectiveStock) : Number(r.stock_qty),
      totalReceived: e ? Number(e.totalReceived) : 0,
      totalSold: e ? Number(e.totalSold) : 0,
    });
  });

  if (asJson) {
    console.log(JSON.stringify({ mode: 'propose-only', count: proposals.length, proposals }, null, 2));
    return;
  }

  console.log('PS-224 negative-stock reconciliation — READ-ONLY, PROPOSE-ONLY (no writes)\n');
  console.log(`  Active rows with stock_qty < 0: ${proposals.length}`);
  const byType = new Map<string, number>();
  for (const p of proposals) byType.set(p.proposalType, (byType.get(p.proposalType) ?? 0) + 1);
  for (const [t, n] of byType) console.log(`    ${t.padEnd(18)} ${n}`);
  const totalDeficit = proposals.reduce((s, p) => s + p.proposedDelta, 0);
  console.log(`  Total units to restore (floor to 0 / ledger): ${totalDeficit}\n`);

  console.log('Proposed corrections (review — NOT applied):');
  for (const p of proposals.slice(0, 40)) {
    console.log(
      `  inv #${p.inventoryId} ${p.sku} (client ${p.clientId ?? 'global'}): ` +
      `cache ${p.cacheStockQty} / ledger ${p.effectiveStock} → propose ${p.proposedLedgerType} +${p.proposedDelta} ` +
      `(→ ${p.resultingStockQty})  [${p.proposalType}]`,
    );
  }
  if (proposals.length > 40) console.log(`  … +${proposals.length - 40} more`);
  console.log('\nNo changes written. Review the proposals, then apply receives/adjustments by hand.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('ps-224 reconcile failed:', err instanceof Error ? err.message : err); process.exit(1); });
