/**
 * PS-133 guard — effective stock has ONE canonical owner and consumers delegate.
 * BEHAVIORAL fixtures for the formula (not string-matching) + static delegation checks.
 *
 *   npx tsx scripts/ps-133-inventory-stock-math-guard.ts
 */
import { readFileSync } from 'node:fs';

// Dummy env so importing the (db-bound) module loads; the guard only calls the PURE
// inventoryLedgerBalance() — no DB connection is opened.
process.env.VERCEL ??= '1';
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ??= 'http://localhost';

const { inventoryLedgerBalance } = await import('../src/services/inventory-stock-math');

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

// ── Behavioral fixtures: the canonical formula ──
check('receive only', inventoryLedgerBalance([{ type: 'receive', qty: 10 }]), 10);

check('dedup duplicate ship rows for one order (min, not sum)', inventoryLedgerBalance([
  { type: 'receive', qty: 10 },
  { type: 'ship', qty: -3, orderId: '101' },
  { type: 'ship', qty: -3, orderId: '101' },
]), 7);

check('includes adjust rows', inventoryLedgerBalance([
  { type: 'receive', qty: 10 },
  { type: 'ship', qty: -3, orderId: '101' },
  { type: 'adjust', qty: -2 },
]), 5);

check('includes remove rows', inventoryLedgerBalance([
  { type: 'receive', qty: 10 },
  { type: 'ship', qty: -3, orderId: '101' },
  { type: 'remove', qty: -1 },
]), 6);

// THE dashboard drift the fix corrects: received(10) - sold(3) = 7 (WRONG, old dashboard),
// canonical includes the adjust(-2) => 5 (CORRECT).
{
  const rows = [
    { type: 'receive', qty: 10 },
    { type: 'ship', qty: -3, orderId: '101' },
    { type: 'adjust', qty: -2 },
  ];
  const oldDriftValue = 10 - 3; // received - sold (the bug)
  check('canonical != old received-minus-sold drift', inventoryLedgerBalance(rows) !== oldDriftValue, true);
  check('canonical balance is correct (5)', inventoryLedgerBalance(rows), 5);
}

// ── Static: one owner, consumers delegate, dashboard drift removed ──
{
  const math = readFileSync('src/services/inventory-stock-math.ts', 'utf8');
  check('owner exports computeEffectiveStockForIds', /export async function computeEffectiveStockForIds/.test(math), true);

  const inv = readFileSync('src/routes/inventory.ts', 'utf8');
  check('inventory list delegates to the owner', /computeEffectiveStockForIds\(/.test(inv), true);
  check('inventory list no longer inlines the ledger_balance CTE', /ledger_balance as \(/.test(inv), false);

  const dash = readFileSync('src/routes/dashboard.ts', 'utf8');
  check('dashboard delegates to the owner', /computeEffectiveStockForIds\(/.test(dash), true);
  check('dashboard no longer computes received-minus-sold drift', /total_received\)\s*\|\|\s*0\)\s*-\s*\(Number\(row\.total_sold/.test(dash), false);

  // Cross-reference docs in the perf-sensitive / raw-driver consumers.
  const reporting = readFileSync('src/services/reporting-metrics.ts', 'utf8');
  check('reporting-metrics cross-references the owner', /inventory-stock-math/.test(reporting), true);
  const script = readFileSync('scripts/reconcile-inventory-stock.ts', 'utf8');
  check('reconcile script cross-references the owner', /inventory-stock-math/.test(script), true);
}

if (failures > 0) {
  console.error(`\nFAIL PS-133 inventory stock-math guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-133 inventory stock-math guard');
