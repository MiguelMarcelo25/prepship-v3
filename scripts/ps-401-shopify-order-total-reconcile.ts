import 'dotenv/config';
import postgres from 'postgres';
import { resolveImportedOrderTotal } from '../src/services/store-order-import';

type CandidateRow = {
  id: number;
  orderNumber: string;
  orderStatus: string;
  orderTotal: string;
  items: unknown[] | null;
  raw: Record<string, unknown> | null;
  rawSourcePayload: Record<string, unknown> | null;
};

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function parseLimit(): number {
  const raw = argValue('limit');
  if (!raw) return 200;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--limit must be a positive number');
  return Math.min(5000, Math.trunc(parsed));
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');

  const apply = hasFlag('apply');
  const orderNumber = argValue('order-number');
  const limit = parseLimit();
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 });

  try {
    const rows = await sql<CandidateRow[]>`
      select
        id,
        order_number as "orderNumber",
        order_status as "orderStatus",
        order_total::text as "orderTotal",
        items,
        raw,
        raw_source_payload as "rawSourcePayload"
      from orders
      where order_total = 0
        and jsonb_array_length(coalesce(items, '[]'::jsonb)) > 0
        and (${orderNumber}::text is null or order_number = ${orderNumber})
      order by updated_at desc nulls last, id desc
      limit ${limit}
    `;

    const candidates = rows
      .map((row) => ({
        row,
        resolution: resolveImportedOrderTotal({
          incomingOrderTotal: row.orderTotal,
          items: row.items ?? [],
          raw: row.raw ?? {},
          rawSourcePayload: row.rawSourcePayload ?? {},
          orderStatus: row.orderStatus,
        }),
      }))
      .filter((entry) => Number(entry.resolution.orderTotal) > 0 && entry.resolution.suspiciousZero);

    console.log(
      `[ps-401-order-total] ${apply ? 'APPLY' : 'DRY RUN'} scanned=${rows.length} candidates=${candidates.length}`,
    );
    if (candidates.length > 0) {
      console.table(
        candidates.slice(0, 50).map(({ row, resolution }) => ({
          id: row.id,
          orderNumber: row.orderNumber,
          status: row.orderStatus,
          from: row.orderTotal,
          to: resolution.orderTotal,
          source: resolution.source,
          itemSubtotal: resolution.itemSubtotal ?? '-',
          apply: ['shipped', 'cancelled'].includes(row.orderStatus) ? 'locked' : 'safe',
        })),
      );
    }

    if (!apply) {
      console.log('Dry run only. Re-run with --apply after reviewing the candidate table.');
      return;
    }

    let updated = 0;
    for (const { row, resolution } of candidates) {
      if (['shipped', 'cancelled'].includes(row.orderStatus)) continue;
      const result = await sql<Array<{ id: number }>>`
        update orders
        set order_total = ${resolution.orderTotal}, updated_at = now()
        where id = ${row.id}
          and order_total = 0
          and order_status not in ('shipped', 'cancelled')
        returning id
      `;
      updated += result.length;
    }
    console.log(`[ps-401-order-total] updated=${updated}`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
