/**
 * PS-222 — package pricing + catalog seeder ENGINE.
 *
 * Billing reads the box price from client_package_prices.price × (1 + billing_config
 * .package_cost_markup/100) — see src/services/billing-box-policy.ts (decidePackageCostLine).
 * packages.unit_cost is the (informational) materials cost. Today both are largely
 * NULL/empty, so the box-cost billing line can't populate. This script turns DJ's
 * supplied pricing data into those rows — it is the "later: seed data" half of PS-222.
 *
 * SAFE BY DEFAULT — three modes:
 *   1. no flags          → PRESENCE AUDIT (read-only): which billable packages lack a
 *                          unit_cost, which active clients lack box prices. No writes.
 *   2. --input <file>    → DRY-RUN: validate the JSON and print the exact plan. No writes.
 *   3. --input <file> --apply → APPLY: perform the writes inside one transaction.
 *
 *   npx tsx scripts/ps-222-package-pricing-seed.ts                 # audit (read-only)
 *   npx tsx scripts/ps-222-package-pricing-seed.ts --input p.json  # dry-run a plan
 *   npx tsx scripts/ps-222-package-pricing-seed.ts --input p.json --apply
 *
 * Input JSON (all sections optional):
 * {
 *   "catalogAdditions": [{ "name":"Bubble Mailer 10.5x15","type":"mailer","length":10.5,
 *                          "width":15,"height":0.5,"tareWeightOz":0,"packageCode":"bubble_mailer_10_5x15",
 *                          "unitCost":0.18 }],
 *   "nameFixes":        [{ "id":93, "name":"8x8x2" }],
 *   "packageUnitCosts": [{ "id":121, "unitCost":0.42 }, { "name":"11x8x6","unitCost":0.55 }],
 *   "clientPrices":     [{ "clientName":"HUGRAB","packageName":"12x10x3","price":1.25,"isCustom":true }]
 * }
 *
 * NOTE (PS-222b shipped): a $0 box with source:'factory' now SHOWS an explicit $0.00
 * billing line (billing-box-policy NO_CHARGE_BOX_SOURCE). A $0 box with any OTHER
 * source is still SUPPRESSED (no line) by policy — so flag your factory boxes with
 * source:'factory'. The audit/plan flags non-factory $0 boxes so it isn't a surprise.
 *
 * READ-ONLY unless --apply. Touches only the packages catalog (shared, no client scope)
 * and client_package_prices. Does NOT touch orders/shipments/shipped-cancelled rows.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { sql } from '../src/db/client';

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');
const inputIdx = process.argv.indexOf('--input');
const inputPath = inputIdx >= 0 ? process.argv[inputIdx + 1] : null;

const InputSchema = z.object({
  catalogAdditions: z.array(z.object({
    name: z.string().min(1),
    type: z.string().default('box'),
    length: z.number().nonnegative(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
    tareWeightOz: z.number().nonnegative().default(0),
    packageCode: z.string().nullish(),
    unitCost: z.number().nonnegative().nullish(),
    // PS-222b: set source:'factory' to make a $0 "no charge" box that SHOWS an
    // explicit $0.00 billing line (billing-box-policy NO_CHARGE_BOX_SOURCE).
    source: z.string().default('catalog'),
  })).default([]),
  nameFixes: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1) })).default([]),
  packageUnitCosts: z.array(z.object({
    id: z.number().int().positive().nullish(),
    name: z.string().nullish(),
    unitCost: z.number().nonnegative(),
  })).default([]),
  clientPrices: z.array(z.object({
    clientId: z.number().int().positive().nullish(),
    clientName: z.string().nullish(),
    packageId: z.number().int().positive().nullish(),
    packageName: z.string().nullish(),
    price: z.number().nonnegative(),
    isCustom: z.boolean().default(true),
  })).default([]),
});

function emit(obj: unknown) {
  if (JSON_OUT) console.log(JSON.stringify(obj, null, 2));
}

async function presenceAudit() {
  console.log('PS-222 package pricing — PRESENCE AUDIT (read-only)\n');

  const missingUnitCost = await sql<{ id: number; name: string }[]>`
    select p.id, p.name
    from packages p
    where p.unit_cost is null
      and (
        exists (select 1 from client_package_prices cpp where cpp.package_id = p.id)
        or exists (select 1 from billing_line_items b where b.package_id = p.id and b.line_type = 'package_cost')
      )
    order by p.id`;

  const clientsMissingPrices = await sql<{ id: number; name: string }[]>`
    select c.id, c.name
    from clients c
    where c.active = true
      and exists (select 1 from billing_line_items b where b.client_id = c.id and b.line_type = 'package_cost')
      and not exists (select 1 from client_package_prices cpp where cpp.client_id = c.id)
    order by c.id`;

  const zeroPriced = await sql<{ n: number }[]>`
    select count(*)::int as n from client_package_prices where price <= 0`;

  console.log(`Billable packages with NULL unit_cost: ${missingUnitCost.length}`);
  for (const p of missingUnitCost.slice(0, 25)) console.log(`  • #${p.id} ${p.name}`);
  if (missingUnitCost.length > 25) console.log(`  … +${missingUnitCost.length - 25} more`);

  console.log(`\nActive clients with billed boxes but NO price rows: ${clientsMissingPrices.length}`);
  for (const c of clientsMissingPrices.slice(0, 25)) console.log(`  • #${c.id} ${c.name}`);

  console.log(`\nclient_package_prices rows priced <= 0 (suppressed by billing policy): ${zeroPriced[0]?.n ?? 0}`);
  console.log('\nProvide --input <file> to seed unit_cost / client prices / catalog rows (dry-run first).');
  emit({ mode: 'audit', missingUnitCost, clientsMissingPrices, zeroPriced: zeroPriced[0]?.n ?? 0 });
}

async function resolvePackageId(ref: { id?: number | null; name?: string | null }): Promise<number | null> {
  if (ref.id != null) return ref.id;
  if (!ref.name) return null;
  const [row] = await sql<{ id: number }[]>`select id from packages where name = ${ref.name} order by id limit 1`;
  return row?.id ?? null;
}
async function resolveClientId(ref: { clientId?: number | null; clientName?: string | null }): Promise<number | null> {
  if (ref.clientId != null) return ref.clientId;
  if (!ref.clientName) return null;
  const [row] = await sql<{ id: number }[]>`select id from clients where name = ${ref.clientName} order by id limit 1`;
  return row?.id ?? null;
}

async function planAndMaybeApply(path: string) {
  const parsed = InputSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  console.log(`PS-222 package pricing — ${APPLY ? 'APPLY' : 'DRY-RUN (no writes)'} from ${path}\n`);

  // Resolve every reference up front so the plan is concrete and unresolved refs abort.
  const unitCostPlan: { id: number; name: string; unitCost: number }[] = [];
  for (const u of parsed.packageUnitCosts) {
    const id = await resolvePackageId(u);
    if (id == null) { console.error(`  ! unit_cost: could not resolve package ${JSON.stringify(u)}`); process.exit(2); }
    const [row] = await sql<{ name: string }[]>`select name from packages where id = ${id}`;
    unitCostPlan.push({ id, name: row?.name ?? '?', unitCost: u.unitCost });
  }
  const pricePlan: { clientId: number; packageId: number; price: number; isCustom: boolean }[] = [];
  for (const cp of parsed.clientPrices) {
    const clientId = await resolveClientId(cp);
    const packageId = await resolvePackageId(cp);
    if (clientId == null || packageId == null) { console.error(`  ! clientPrice: could not resolve ${JSON.stringify(cp)}`); process.exit(2); }
    pricePlan.push({ clientId, packageId, price: cp.price, isCustom: cp.isCustom });
  }

  console.log(`Catalog additions: ${parsed.catalogAdditions.length}`);
  for (const a of parsed.catalogAdditions) {
    const isFactory = a.source === 'factory';
    const flag = (a.unitCost ?? 1) <= 0
      ? (isFactory
          ? '  [no-charge factory box — shows explicit $0.00 line (PS-222b)]'
          : '  [⚠ $0 but source!=factory — billing still suppresses the line]')
      : '';
    console.log(`  + ${a.name} (${a.type}, source=${a.source}) ${a.length}x${a.width}x${a.height}${flag}`);
  }
  console.log(`Name fixes: ${parsed.nameFixes.length}`);
  for (const n of parsed.nameFixes) console.log(`  ~ #${n.id} → "${n.name}"`);
  console.log(`Package unit_cost updates: ${unitCostPlan.length}`);
  for (const u of unitCostPlan.slice(0, 30)) console.log(`  $ #${u.id} ${u.name} → unit_cost ${u.unitCost.toFixed(2)}`);
  console.log(`Client price upserts: ${pricePlan.length}`);
  for (const p of pricePlan.slice(0, 30)) console.log(`  $ client ${p.clientId} / pkg ${p.packageId} → ${p.price.toFixed(2)}${p.isCustom ? ' (custom)' : ''}`);

  emit({ mode: APPLY ? 'apply' : 'dry-run', catalogAdditions: parsed.catalogAdditions, nameFixes: parsed.nameFixes, unitCostPlan, pricePlan });

  if (!APPLY) {
    console.log('\nDRY-RUN only — no rows written. Re-run with --apply to commit.');
    return;
  }

  await sql.begin(async (tx) => {
    for (const a of parsed.catalogAdditions) {
      await tx`insert into packages (name, type, length, width, height, tare_weight_oz, source, package_code, unit_cost)
               values (${a.name}, ${a.type}, ${a.length}, ${a.width}, ${a.height}, ${a.tareWeightOz},
                       ${a.source}, ${a.packageCode ?? null}, ${a.unitCost ?? null})`;
    }
    for (const n of parsed.nameFixes) {
      await tx`update packages set name = ${n.name}, updated_at = now() where id = ${n.id}`;
    }
    for (const u of unitCostPlan) {
      await tx`update packages set unit_cost = ${u.unitCost}, updated_at = now() where id = ${u.id}`;
    }
    for (const p of pricePlan) {
      await tx`insert into client_package_prices (client_id, package_id, price, is_custom, updated_at)
               values (${p.clientId}, ${p.packageId}, ${p.price}, ${p.isCustom}, now())
               on conflict (client_id, package_id)
               do update set price = excluded.price, is_custom = excluded.is_custom, updated_at = now()`;
    }
  });
  console.log('\nAPPLIED. Re-run the audit to confirm, and regenerate billing (Update Billing) to pick up new prices.');
}

async function main() {
  if (!inputPath) { await presenceAudit(); return; }
  await planAndMaybeApply(inputPath);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('ps-222 seed failed:', err instanceof Error ? err.message : err); process.exit(1); });
