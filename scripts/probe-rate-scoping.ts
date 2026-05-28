#!/usr/bin/env tsx
// Diagnose why the Rate Browser shows 22 carriers (DRP + KFG mixed).
// Walks every client through the same credential resolution the Rate
// Browser uses, then asks the ShipStation CarrierConnector for carrier
// accounts via the resolved key to see what each client *should* see.
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';
import { loadClientCredentials } from '../src/lib/shipstation/credentials';
import { listCarrierAccounts } from '../src/services/carrier-connector-orchestrator';

function pad(s: string, n: number) {
  return (s ?? '').padEnd(n).slice(0, n);
}

async function main() {
  console.log('\n=== Rate Browser carrier-scoping probe ===\n');

  const rows = await db.execute<{
    id: number;
    name: string;
    has_ss_api_key_v2: boolean;
    has_ss_api_key: boolean;
    rate_source_client_id: number | null;
    store_ids: number[] | null;
    active: boolean;
  }>(sql`
    select
      id,
      name,
      ss_api_key_v2 is not null as has_ss_api_key_v2,
      ss_api_key   is not null as has_ss_api_key,
      rate_source_client_id,
      store_ids,
      active
    from clients
    order by id
  `);

  console.log(`Found ${rows.length} clients.\n`);
  console.log(
    `${pad('id', 4)} ${pad('client', 26)} ${pad('act', 4)} ${pad('v2key', 6)} ${pad('rateSrc', 8)} ${pad('storeIds', 26)}`
  );
  console.log('-'.repeat(80));
  for (const r of rows) {
    console.log(
      `${pad(String(r.id), 4)} ${pad(r.name, 26)} ${pad(String(r.active), 4)} ${pad(r.has_ss_api_key_v2 ? 'yes' : 'no', 6)} ${pad(String(r.rate_source_client_id ?? '—'), 8)} ${pad(JSON.stringify(r.store_ids ?? []), 26)}`
    );
  }
  console.log('');

  // Test the resolution path for each client.
  console.log('Carrier counts via the actual credential resolution:\n');
  console.log(
    `${pad('clientId', 10)} ${pad('source', 10)} ${pad('apiKey?', 9)} ${pad('carriers returned by SS', 30)}`
  );
  console.log('-'.repeat(80));

  // Probe clientId=null (the env-default fallback path — what an unscoped
  // request would see).
  {
    const creds = await loadClientCredentials(null);
    const carriersRes = await listCarrierAccounts('shipstation', {
      apiKey: creds.apiKeyV2 ?? undefined,
      dedupeKey: `probe:carriers:env`,
    });
    const codes = (carriersRes.carriers ?? []).map((c) => `${c.carrier_code}:${c.nickname ?? c.friendly_name ?? c.carrier_id}`);
    console.log(
      `${pad('null', 10)} ${pad('env', 10)} ${pad(creds.apiKeyV2 ? 'client' : 'env', 9)} ${pad(String(carriersRes.carriers?.length ?? 0), 4)}  ${codes.slice(0, 5).join(' | ')}${codes.length > 5 ? ` … +${codes.length - 5}` : ''}`
    );
  }

  for (const r of rows) {
    if (!r.active) continue;
    try {
      const creds = await loadClientCredentials(r.id);
      const carriersRes = await listCarrierAccounts('shipstation', {
        apiKey: creds.apiKeyV2 ?? undefined,
        dedupeKey: `probe:carriers:client:${r.id}`,
      });
      const codes = (carriersRes.carriers ?? []).map(
        (c) => `${c.carrier_code}:${c.nickname ?? c.friendly_name ?? c.carrier_id}`
      );
      const source = creds.sourceClientId === r.id
        ? 'self'
        : creds.sourceClientId != null
          ? `→ ${creds.sourceClientId}`
          : 'env-fallback';
      console.log(
        `${pad(String(r.id), 10)} ${pad(source, 10)} ${pad(creds.apiKeyV2 ? 'client' : 'env', 9)} ${pad(String(carriersRes.carriers?.length ?? 0), 4)}  ${codes.slice(0, 5).join(' | ')}${codes.length > 5 ? ` … +${codes.length - 5}` : ''}`
      );
    } catch (err) {
      console.log(
        `${pad(String(r.id), 10)} ${pad('error', 10)} ${pad('—', 9)} ${err instanceof Error ? err.message : err}`
      );
    }
  }
  console.log('');
  console.log('What to look for:');
  console.log('  • If "apiKey?" column says "env" for an order, the request is');
  console.log('    not scoped — SS returns all carriers across all linked accounts.');
  console.log('  • If "carriers returned by SS" is high (15-25) for any row, that');
  console.log('    underlying SS account aggregates many carrier accounts — and');
  console.log('    scoping by clientId only narrows to that account, NOT to the');
  console.log('    individual nicknamed carrier within it.');
}

main()
  .catch((err) => {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgClient.end({ timeout: 5 });
  });
