import { getInventoryDeductionReport } from '../src/services/fulfillment/inventory-deduction-report.js';

function usage(): void {
  console.log(`Read-only inventory deduction outbox report.

Usage:
  npm run inventory:deduction-report -- [--limit <1-500>]

Shows pending, processing, retrying, exhausted, and kill-switch-parked rows.
No order, shipment, inventory, ledger, outbox, label, or provider state is changed.`);
}

function readLimit(argv: string[]): number | undefined {
  const index = argv.indexOf('--limit');
  if (index < 0) return undefined;
  const limit = Number(argv[index + 1]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('--limit must be an integer from 1 through 500');
  }
  return limit;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const limit = readLimit(argv);
  const [{ sql }, { env }] = await Promise.all([
    import('../src/db/client.js'),
    import('../src/lib/env.js'),
  ]);
  try {
    const report = await getInventoryDeductionReport(sql, {
      inventoryAutoDeductEnabled: env.INVENTORY_AUTO_DEDUCT,
      limit,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
