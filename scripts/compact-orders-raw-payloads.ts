import 'dotenv/config';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import {
  retainOrderRawForPersistence,
  retainOrderRawSourcePayloadForPersistence,
} from '../src/services/order-raw-payload-policy';

type OrderRawRow = {
  id: number;
  source_provider: string | null;
  order_status: string;
  raw: unknown;
  raw_source_payload: unknown;
  raw_bytes: number;
  source_bytes: number;
};

type PendingUpdate = {
  id: number;
  retained_raw: Record<string, unknown>;
  expected_raw: unknown;
  expected_source: unknown;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function positiveInteger(name: string, fallback: number, max: number): number {
  const value = Number(argValue(name) ?? fallback);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`--${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

const apply = hasFlag('apply');
const confirmation = argValue('confirm');
if (apply && confirmation !== 'compact-orders-raw') {
  throw new Error('Apply mode requires --confirm=compact-orders-raw');
}

const batchSize = positiveInteger('batch-size', 250, 1_000);
const maxRows = positiveInteger('max-rows', apply ? 1_000 : 100_000, 1_000_000);
let cursor = Number(argValue('after-id') ?? 0);
if (!Number.isInteger(cursor) || cursor < 0) {
  throw new Error('--after-id must be a non-negative integer');
}

const sql = postgres(process.env.DATABASE_URL ?? '', {
  prepare: false,
  max: 1,
  max_pipeline: 1,
  idle_timeout: 5,
  connection: { statement_timeout: 30_000 },
});

let scanned = 0;
let candidates = 0;
let updated = 0;
let estimatedLogicalBytesRemoved = 0;
const candidatesByStatus = new Map<string, number>();

try {
  while (scanned < maxRows) {
    const limit = Math.min(batchSize, maxRows - scanned);
    const rows = await sql<OrderRawRow[]>`
      select
        id,
        source_provider,
        order_status,
        raw,
        raw_source_payload,
        pg_column_size(raw)::int as raw_bytes,
        coalesce(pg_column_size(raw_source_payload), 0)::int as source_bytes
      from orders
      where id > ${cursor}
      order by id
      limit ${limit}
    `;
    if (!rows.length) break;

    const pending: PendingUpdate[] = [];
    for (const row of rows) {
      const retainedRaw = retainOrderRawForPersistence({
        sourceProvider: row.source_provider,
        raw: row.raw,
      });
      const retainedSource = retainOrderRawSourcePayloadForPersistence(row.raw_source_payload);
      const rawChanged = !isDeepStrictEqual(retainedRaw, row.raw);
      const sourceChanged = !isDeepStrictEqual(retainedSource, row.raw_source_payload);
      if (!rawChanged && !sourceChanged) continue;

      candidates += 1;
      candidatesByStatus.set(
        row.order_status,
        (candidatesByStatus.get(row.order_status) ?? 0) + 1,
      );
      estimatedLogicalBytesRemoved += Math.max(
        0,
        row.raw_bytes + row.source_bytes - jsonBytes(retainedRaw),
      );
      pending.push({
        id: row.id,
        retained_raw: retainedRaw,
        expected_raw: row.raw,
        expected_source: row.raw_source_payload,
      });
    }

    if (apply && pending.length) {
      // Per user override unlock shipped data on 2026-07-15: this maintenance
      // write changes only the bounded raw JSONB projection. It deliberately
      // leaves order_status, updated_at, shipments, labels, inventory, billing,
      // and marketplace-confirmation state untouched. The expected-value
      // predicates make a concurrent sync win instead of losing fresh data.
      const changed = await sql<{ id: number }[]>`
        update orders o
        set
          raw = payload.retained_raw,
          raw_source_payload = null
        from jsonb_to_recordset(${sql.json(pending)}::jsonb) as payload(
          id integer,
          retained_raw jsonb,
          expected_raw jsonb,
          expected_source jsonb
        )
        where o.id = payload.id
          and o.raw is not distinct from payload.expected_raw
          and o.raw_source_payload is not distinct from payload.expected_source
        returning o.id
      `;
      updated += changed.length;
    }

    scanned += rows.length;
    cursor = rows.at(-1)?.id ?? cursor;
    if (rows.length < limit) break;
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    scanned,
    candidates,
    updated: apply ? updated : null,
    compareAndSwapSkipped: apply ? candidates - updated : null,
    estimatedLogicalBytesRemoved,
    candidatesByStatus: Object.fromEntries(candidatesByStatus),
    nextAfterId: cursor,
  }, null, 2));
  if (apply) {
    console.log('Run the next bounded batch with --after-id=<nextAfterId>. After completion, use DBA-managed VACUUM (ANALYZE) and inspect bloat; do not run VACUUM FULL during live traffic.');
  }
} finally {
  await sql.end();
}
