/**
 * PS-373 (slice 2) guard — the FROZEN storage-proof sidecar is persisted by the
 * billing owner, exposed through an admin read route, and consumed by an FE
 * drilldown that owns NO storage math. Static source pins across the schema,
 * migration, runtime ensure, service persist, route, api client, and FE — plus
 * the slice-1 storage-line dating fix the proof consistency depends on.
 *
 *   npx tsx scripts/ps-373-storage-proof-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}
const read = (p: string) => readFileSync(p, 'utf8');

// ── 1) Schema — additive sidecar table, period-keyed unique constraint ──
const schema = read('src/db/schema/billing.ts');
check('schema: billingStorageProof table declared', /export const billingStorageProof = pgTable\(\s*\n?\s*'billing_storage_proof'/.test(schema));
check('schema: keyed unique on (clientId, periodStart, periodEnd)',
  /unique\('billing_storage_proof_client_period_unq'\)\.on\(t\.clientId, t\.periodStart, t\.periodEnd\)/.test(schema));
check('schema: proof stored as jsonb', /proof:\s*jsonb\(\)\.notNull\(\)/.test(schema) && /\bjsonb,/.test(schema));
check('schema: cascades on client delete (additive FK, no shipment coupling)',
  /clientId: integer\(\)\s*\n\s*\.notNull\(\)\s*\n\s*\.references\(\(\) => clients\.id, \{ onDelete: 'cascade' \}\)/.test(schema));

// ── 2) Migration 0055 mirrors the table + constraint ──
const mig = read('drizzle/0055_billing_storage_proof.sql');
check('migration 0055: CREATE TABLE IF NOT EXISTS billing_storage_proof', /CREATE TABLE IF NOT EXISTS "billing_storage_proof"/.test(mig));
check('migration 0055: period-keyed unique constraint',
  /CONSTRAINT "billing_storage_proof_client_period_unq" UNIQUE \("client_id", "period_start", "period_end"\)/.test(mig));
check('migration 0055: proof jsonb column', /"proof" jsonb NOT NULL/.test(mig));

// ── 3) Runtime ensure mirrors the migration + is memoized/idempotent ──
const ensure = read('src/db/ensure-billing-storage-proof.ts');
check('ensure delegates to migration readiness', /assertRuntimeSchemaReady/.test(ensure));
check('ensure contains no table DDL', !/CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(ensure));
check('shared readiness is memoized', /let readiness: Promise<void> \| null = null/.test(read('src/services/runtime-schema-readiness.ts')));

// ── 4) Runtime-DDL inventory documents the new ensure ──
const ddlGuard = read('scripts/runtime-ddl-guard.mjs');
const ddlAudit = read('RUNTIME_DDL_MIGRATION_AUDIT.md');
check('runtime-ddl guard tracks the readiness caller', ddlGuard.includes("'src/db/ensure-billing-storage-proof.ts'"));
check('runtime-ddl audit documents the ensure file', ddlAudit.includes('`src/db/ensure-billing-storage-proof.ts`') && ddlAudit.includes('0055_billing_storage_proof.sql'));

// ── 5) billing.ts persists the proof (period-keyed upsert) and freezes evidence ──
const billing = read('src/services/billing.ts');
check('billing imports the proof table + ensure',
  /billingStorageProof,/.test(billing) && /ensureBillingStorageProofSchema/.test(billing));
const storageBlock = billing.slice(billing.indexOf('Storage fees (PS-373'));
check('billing freezes the proof via ensure + upsert', /await ensureBillingStorageProofSchema\(\)/.test(storageBlock) && /\.insert\(billingStorageProof\)/.test(storageBlock));
check('billing upserts on the period key (onConflictDoUpdate, not silent drop)',
  /onConflictDoUpdate\(\{[\s\S]*billingStorageProof\.clientId,[\s\S]*billingStorageProof\.periodStart,[\s\S]*billingStorageProof\.periodEnd/.test(storageBlock));
check('billing freezes the full per-SKU + exceptions evidence',
  /proof: \{ skuProofs: storage\.skuProofs, exceptions: storage\.exceptions \}/.test(storageBlock));
check('billing gates the storage charge on durable proof',
  /await ensureBillingStorageProofSchema\(\)[\s\S]*await db\.transaction\(async \(tx\) =>/.test(storageBlock) &&
    /tx\s*\n\s*\.insert\(billingStorageProof\)[\s\S]*tx\s*\n\s*\.insert\(billingLineItems\)/.test(storageBlock) &&
    /catch \(storageErr\)[\s\S]*skipped \+= 1/.test(storageBlock) &&
    /reportError\('billing\.storage_line\.freeze_failed', storageErr/.test(storageBlock) &&
    !/storage line generated but proof freeze failed/.test(storageBlock));

// ── 5b) Slice-1 dating FIX the proof consistency depends on: the storage line is
//        dated on the LAST billed day (inside [from, to)), not the exclusive end.
check('billing dates the storage line inside the period (last billed day)',
  /const storageShipDate = new Date\(periodEnd\.getTime\(\) - STORAGE_LINE_DAY_MS\)/.test(storageBlock) &&
  /shipDate: storageShipDate/.test(storageBlock));
check('billing no longer dates the storage line on the exclusive period end',
  !/shipDate: periodEnd/.test(storageBlock));

// ── 6) Admin read route — scoped, reads the sidecar, recomputes NOTHING ──
const route = read('src/routes/billing.ts');
check('route: GET /storage-proof exists', /app\.get\('\/storage-proof'/.test(route));
const routeBlock = route.slice(route.indexOf("app.get('/storage-proof'"), route.indexOf("app.get('/storage-proof'") + 1400);
check('route: financials:read + per-client scope enforced',
  /app\.use\('\*', requirePermission\('financials:read'\)\)/.test(route) && /canAccessBillingClient\(q\.clientId, scope\)/.test(routeBlock));
check('route: reads the frozen sidecar', /\.from\(billingStorageProof\)/.test(routeBlock));
check('route: matches the canonical period bounds (same instants billing froze)',
  /billingStorageProof\.periodStart\} = \$\{q\.dateFrom\}::timestamptz/.test(routeBlock) &&
  /billingStorageProof\.periodEnd\} = \$\{q\.dateTo\}::timestamptz/.test(routeBlock));
check('route: does NOT recompute storage (no calculator call in the route)', !/computeClientStorageBilling/.test(route));

// ── 7) FE api client — honest-error contract, not wrapped in safe(...) ──
const apiClient = read('web/src/lib/v2-apiClient.ts');
check('api client: fetchBillingStorageProof method', /fetchBillingStorageProof\(clientId: number, from: string, to: string\)/.test(apiClient));
const apiBlock = apiClient.slice(apiClient.indexOf('fetchBillingStorageProof('), apiClient.indexOf('fetchBillingStorageProof(') + 400);
check('api client: real failure rejects (not wrapped in safe → no false empty)', !/safe\(/.test(apiBlock) && /\/billing\/storage-proof/.test(apiBlock));

// ── 8) FE modal — thin consumer, renders the frozen proof, owns no storage math ──
const modal = read('web/src/components/Views/BillingStorageProofModal.tsx');
check('FE modal: fetches the proof via the api client', /apiClient\s*\n?\s*\.fetchBillingStorageProof\(clientId, from, to\)/.test(modal));
check('FE modal: renders per-SKU proof + segments + exceptions',
  /skuProofs/.test(modal) && /segments\.map/.test(modal) && /exceptions\.map/.test(modal));
check('FE modal: displays the backend daily rate (does NOT recompute it)',
  /data\.dailyRatePerCuFt/.test(modal) && !/monthlyRatePerCuFt\s*\/\s*(daysInMonth|data\.daysInMonth)/.test(modal));

// ── 9) FE wiring — storage line opens the drilldown ──
const detailTable = read('web/src/components/Views/BillingDetailTable.tsx');
check('detail table: optional onOpenStorageProof prop', /onOpenStorageProof\?: \(\) => void/.test(detailTable));
check('detail table: the storage line triggers the drilldown',
  /row\.lineType === 'storage' && onOpenStorageProof/.test(detailTable) && /Storage · proof/.test(detailTable));
const view = read('web/src/components/Views/BillingView.tsx');
check('BillingView: mounts the proof modal + passes the trigger',
  /<BillingStorageProofModal/.test(view) && /onOpenStorageProof=\{\(\) => setStorageProofOpen\(true\)\}/.test(view));

// ── 10) package.json wires this guard ──
const pkg = read('package.json');
check('package.json wires test:ps-373-storage-proof', /"test:ps-373-storage-proof":/.test(pkg));

if (failures > 0) {
  console.error(`\nPS-373 storage-proof guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-373 storage-proof guard passed.');
