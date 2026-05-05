#!/usr/bin/env tsx
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('\n=== Probe package usage ===\n');

  console.log('1. Custom packages (source=custom):');
  const pkgs = await db.execute<{
    id: number;
    name: string;
    length: number | null;
    width: number | null;
    height: number | null;
    stock_qty: number;
    source: string | null;
    created_at: string;
  }>(sql`
    select id, name, length, width, height, stock_qty, source, created_at
    from packages
    where source = 'custom' or name like 'Custom %'
    order by created_at desc
    limit 20
  `);
  for (const p of pkgs) {
    console.log(`  id=${p.id}  ${p.name.padEnd(22)}  ${p.length}x${p.width}x${p.height}  stock=${p.stock_qty}  src=${p.source}`);
  }
  console.log('');

  console.log('2. package_ledger entries for those packages (any date):');
  const ledger = await db.execute<{
    id: number;
    package_id: number;
    change_type: string;
    qty_delta: number;
    balance_after: number;
    note: string | null;
    created_at: string;
  }>(sql`
    select pl.id, pl.package_id, pl.change_type, pl.qty_delta, pl.balance_after, pl.note, pl.created_at
    from package_ledger pl
    join packages p on p.id = pl.package_id
    where p.source = 'custom' or p.name like 'Custom %'
    order by pl.created_at desc
    limit 30
  `);
  if (!ledger.length) {
    console.log('  (none — package deduction has never written for any custom package)');
  }
  for (const l of ledger) {
    console.log(`  pkg=${l.package_id}  ${l.change_type.padEnd(8)}  qty=${l.qty_delta}  bal_after=${l.balance_after}  ${l.created_at}  note=${l.note}`);
  }
  console.log('');

  console.log('3. Recent shipments with selected_package_id pointing at any of those packages:');
  const ships = await db.execute<{
    id: number;
    order_id: number;
    selected_package_id: string | null;
    label_carrier: string | null;
    label_service: string | null;
    label_tracking: string | null;
    dims_l: number | null;
    dims_w: number | null;
    dims_h: number | null;
    create_date: string;
  }>(sql`
    select s.id, s.order_id, s.selected_package_id, s.label_carrier, s.label_service,
           s.label_tracking, s.dims_l, s.dims_w, s.dims_h, s.create_date
    from shipments s
    where s.selected_package_id in (
      select id::text from packages where source = 'custom' or name like 'Custom %'
    )
       or (s.dims_l between 89 and 91 and s.dims_w between 89 and 91 and s.dims_h between 89 and 91)
       or (s.dims_l between 89 and 91 and s.dims_w between 7 and 9 and s.dims_h between 4 and 6)
    order by s.create_date desc
    limit 20
  `);
  if (!ships.length) {
    console.log('  (no shipments matching either selected_package_id or 90x90x90 / 90x8x5 dims)');
  }
  for (const s of ships) {
    console.log(`  ship=${s.id}  ord=${s.order_id}  selected_pkg=${s.selected_package_id ?? '-'}  dims=${s.dims_l}x${s.dims_w}x${s.dims_h}  ${s.create_date}`);
  }
  console.log('');

  console.log('4. How many shipments overall use selected_package_id at all:');
  const cnt = await db.execute<{ total: number; with_pkg: number; recent_with_pkg: number }>(sql`
    select
      count(*)::int as total,
      count(*) filter (where selected_package_id is not null)::int as with_pkg,
      count(*) filter (
        where selected_package_id is not null
          and create_date >= now() - interval '30 days'
      )::int as recent_with_pkg
    from shipments
  `);
  const c = cnt[0];
  console.log(`  total shipments:            ${c?.total ?? 0}`);
  console.log(`  with selected_package_id:   ${c?.with_pkg ?? 0}`);
  console.log(`  ↳ in last 30 days:          ${c?.recent_with_pkg ?? 0}`);
}

main()
  .catch((err) => {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgClient.end({ timeout: 5 });
  });
