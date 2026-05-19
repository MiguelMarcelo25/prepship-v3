import 'dotenv/config';
import postgres from 'postgres';
import {
  type MarketplaceProvider,
  reconcileMarketplaceOrderStatuses,
} from '../api/_lib/marketplace-status-reconciliation.ts';

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseProvider(): MarketplaceProvider[] {
  const raw = (argValue('provider') ?? 'all').toLowerCase();
  if (raw === 'all') return ['walmart', 'ebay'];
  if (raw === 'walmart' || raw === 'ebay') return [raw];
  throw new Error('--provider must be walmart, ebay, or all');
}

function parseOrderNumbers(): string[] | undefined {
  const raw = argValue('order-number') ?? argValue('order-numbers');
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function parseStoreAccountId(): number | undefined {
  const raw = argValue('store-account-id');
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('--store-account-id must be a positive number');
  }
  return value;
}

function printUsage(): void {
  console.log(`
Usage:
  npm run marketplace:reconcile -- --provider walmart --order-number 200014896300359
  npm run marketplace:reconcile -- --provider walmart --store-account-id 1
  npm run marketplace:reconcile:apply -- --provider walmart --store-account-id 1

Defaults:
  --provider all
  dry-run mode unless --apply is present

Safety:
  Only orders currently awaiting_shipment can be updated.
  Synthetic marketplace mirror rows are ignored.
`);
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    printUsage();
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');

  const apply = hasFlag('apply');
  const providers = parseProvider();
  const orderNumbers = parseOrderNumbers();
  const storeAccountId = parseStoreAccountId();
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    for (const provider of providers) {
      const result = await reconcileMarketplaceOrderStatuses(sql, {
        provider,
        storeAccountId,
        orderNumbers,
        dryRun: !apply,
      });

      console.log(`\n[${provider}] ${apply ? 'APPLY' : 'DRY RUN'}`);
      console.log(
        `checked=${result.checkedOrderNumbers} candidates=${result.candidates.length} updated=${result.updated} skipped=${result.skipped.length}`,
      );

      if (result.candidates.length) {
        console.table(
          result.candidates.map((candidate) => ({
            id: candidate.id,
            orderNumber: candidate.orderNumber,
            externalOrderId: candidate.externalOrderId,
            from: candidate.currentStatus,
            to: candidate.targetStatus,
            sourceStatuses: [...new Set(candidate.sourceStatuses)].join(', '),
          })),
        );
      }

      const open = result.skipped.filter((row) => row.reason === 'marketplace still open');
      if (open.length) {
        console.log(`[${provider}] still open: ${open.map((row) => row.orderNumber).join(', ')}`);
      }
    }

    if (!apply) {
      console.log('\nDry run only. Re-run with --apply after reviewing the candidate table.');
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
