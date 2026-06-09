/**
 * PS-132 guard — shared foundations have ONE owner and all consumers delegate.
 * Covers (this slice): scheduler cadence + synthetic/system-client names.
 * Pure logic + static source assertions. No DB, no network.
 *
 *   npx tsx scripts/ps-132-shared-foundations-guard.ts
 */
import { readFileSync } from 'node:fs';
import { SYNC_CADENCE_MS, SYNC_CADENCE_MINUTES } from '../src/lib/sync-cadence';
import { SYSTEM_CLIENT_NAMES, isSystemClientName } from '../src/lib/system-clients';
import {
  KNOWN_CARRIER_ACCOUNTS,
  resolveKnownCarrierAccount,
  knownCarrierNickname,
  knownCarrierCode,
} from '../src/lib/carrier-account-registry';
import {
  activeClientPredicateSql,
  testOrInactiveClientPredicateSql,
} from '../src/lib/active-client-predicate';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures += 1;
    console.error(`FAIL ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── Scheduler cadence: derived minutes match the canonical ms intervals ──
{
  check('cadence minutes derived from ms (orders)', SYNC_CADENCE_MINUTES.orders, SYNC_CADENCE_MS.orders / 60_000);
  check('cadence minutes derived from ms (rateBackfill)', SYNC_CADENCE_MINUTES.rateBackfill, SYNC_CADENCE_MS.rateBackfill / 60_000);
  // Legacy status payload values must be preserved exactly.
  check('status cadence == legacy values', SYNC_CADENCE_MINUTES, {
    orders: 3, shipments: 3, rateBackfill: 10, inventoryFromOrders: 30, productCatalog: 60, reportingMetrics: 30,
  });

  const queue = readFileSync('src/services/sync-job-queue.ts', 'utf8');
  check('sync-job-queue imports the shared cadence', /from '\.\.\/lib\/sync-cadence'/.test(queue), true);
  check('sync-job-queue no longer hardcodes 3 * 60 * 1000', /=\s*3 \* 60 \* 1000/.test(queue), false);

  const route = readFileSync('src/routes/sync.ts', 'utf8');
  check('status endpoint uses SYNC_CADENCE_MINUTES', /cadenceMinutes:\s*SYNC_CADENCE_MINUTES/.test(route), true);
  check('status endpoint no longer hardcodes a cadence object', /cadenceMinutes:\s*\{\s*orders:\s*3/.test(route), false);
}

// ── System clients: one source; all consumers delegate; no stray literal lists ──
{
  check('system clients constant', SYSTEM_CLIENT_NAMES, ['Manual Orders', 'Rate Browser', 'Api Shipments']);
  check('isSystemClientName(Manual Orders)', isSystemClientName('Manual Orders'), true);
  check('isSystemClientName(Acme)', isSystemClientName('Acme'), false);
  check('isSystemClientName(null)', isSystemClientName(null), false);

  const literal = /'Manual Orders',\s*'Rate Browser',\s*'Api Shipments'/;
  for (const f of [
    'src/routes/billing.ts',
    'src/services/billing.ts',
    'src/services/reporting-metrics.ts',
  ]) {
    const src = readFileSync(f, 'utf8');
    check(`${f} imports SYSTEM_CLIENT_NAMES`, /SYSTEM_CLIENT_NAMES/.test(src) || /systemClientNamesSql/.test(src), true);
    check(`${f} has no hardcoded system-client literal list`, literal.test(src), false);
  }
  // The constant itself lives only in the shared module.
  const lib = readFileSync('src/lib/system-clients.ts', 'utf8');
  check('system-clients.ts holds the canonical list', literal.test(lib), true);
}

// ── Carrier-account registry: one source; drift reconciled; consumers delegate ──
{
  check('registry has the full known account set', KNOWN_CARRIER_ACCOUNTS.length, 16);
  // The PS-132 drift: provider 433543 must resolve to ONE canonical nickname everywhere.
  check('433543 nickname reconciled', knownCarrierNickname('se-433543'), 'UPS by SS - Chase x7439');
  check('433543 resolvable by bare provider id', knownCarrierNickname(433543), 'UPS by SS - Chase x7439');
  check('433543 carrier code', knownCarrierCode('se-433543'), 'ups_walleted');
  check('resolve by provider id returns the account', resolveKnownCarrierAccount(596001)?.nickname, 'ORION');
  check('unknown id resolves to null', resolveKnownCarrierAccount('se-000000'), null);

  const rates = readFileSync('src/services/rates.ts', 'utf8');
  check('rates.ts derives overrides from the registry', /KNOWN_CARRIER_ACCOUNTS\.map/.test(rates), true);
  check('rates.ts no longer hardcodes the se-433543 nickname', /'se-433543',\s*\{[^}]*Chase x7439/.test(rates), false);

  const orders = readFileSync('src/routes/orders.ts', 'utf8');
  check('orders.ts derives refs from the registry', /KNOWN_CARRIER_ACCOUNTS\.map/.test(orders), true);
  check('orders.ts no longer hardcodes the 433542 ref literal', /shippingProviderId:\s*433542,\s*nickname:/.test(orders), false);
}

// ── Active-client visibility predicate: one source; renders byte-identical SQL ──
{
  // EXACT strings the inline raw SQL used before — behavior must be unchanged.
  check('active predicate (c) renders identical SQL', activeClientPredicateSql('c'), 'coalesce(c.active, true) = true');
  check('active predicate (owner_client) alias', activeClientPredicateSql('owner_client'), 'coalesce(owner_client.active, true) = true');
  check('test-or-inactive predicate (c) renders identical SQL', testOrInactiveClientPredicateSql('c'), '(c.is_test = true or coalesce(c.active, true) = false)');

  // No route still hardcodes the predicate (comments excluded).
  const routes = [
    'src/routes/analysis.ts', 'src/routes/clients.ts', 'src/routes/dashboard.ts',
    'src/routes/init.ts', 'src/routes/inventory.ts', 'src/routes/manifests.ts',
    'src/routes/orders.ts', 'src/routes/parent-skus.ts', 'src/routes/shipments.ts',
  ];
  for (const f of routes) {
    const src = readFileSync(f, 'utf8');
    const realInline = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.includes('--') && !line.includes('←'))
      .some((line) => /coalesce\([a-z_]+\.active, true\) = (true|false)/.test(line));
    check(`${f} has no real inline active predicate`, realInline, false);
    check(`${f} imports the active-client predicate helper`, /active-client-predicate/.test(src), true);
  }
}

if (failures > 0) {
  console.error(`\nFAIL PS-132 shared foundations guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-132 shared foundations guard');
