/**
 * PS-223 — packaging rule engine DRY-RUN (READ-ONLY).
 *
 * Shows what the rule engine WOULD assign for awaiting orders given the currently
 * seeded client_sku_classes + client_packing_rules. Writes nothing. Until DJ seeds
 * the 53-SKU classification + rules 1–9, this reports "0 rules configured" and every
 * order falls to skip:unclassified / skip:no-rule — which is the expected pre-seed
 * state. After seeding, re-run to review assignments BEFORE any apply pass.
 *
 *   npx tsx scripts/ps-223-packaging-rules-dry-run.ts [--client-id N] [--limit N] [--json]
 */
import { planPackagingForAwaitingOrders } from '../src/services/packaging-rules';

function argNum(flag: string): number | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

async function main() {
  const clientId = argNum('--client-id');
  const limit = argNum('--limit');
  const asJson = process.argv.includes('--json');

  const report = await planPackagingForAwaitingOrders({ clientId, limit });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('PS-223 packaging rule engine — DRY-RUN (read-only, no writes)\n');
  console.log(`  SKU classes configured : ${report.classesTotal}`);
  console.log(`  Packing rules configured: ${report.rulesTotal}`);
  console.log(`  Clients with config     : ${report.clientsConfigured}`);
  console.log(`  Awaiting orders considered: ${report.ordersConsidered}`);
  console.log(`  Would assign a package  : ${report.wouldAssign}\n`);

  const byAction = new Map<string, number>();
  for (const r of report.rows) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
  console.log('Action breakdown:');
  for (const [action, n] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${action.padEnd(24)} ${n}`);
  }

  const assigns = report.rows.filter((r) => r.action === 'assign').slice(0, 20);
  if (assigns.length) {
    console.log('\nSample would-assign (first 20):');
    for (const r of assigns) {
      console.log(`  order ${r.orderId} (client ${r.clientId})  ${r.ruleKey}  → package ${r.matchedPackageId ?? '—'}`);
    }
  }
  if (report.rulesTotal === 0) {
    console.log('\nNo packing rules seeded yet — seed client_sku_classes + client_packing_rules, then re-run.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('ps-223 dry-run failed:', err instanceof Error ? err.message : err); process.exit(1); });
