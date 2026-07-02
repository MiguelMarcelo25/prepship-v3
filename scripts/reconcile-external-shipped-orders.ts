import 'dotenv/config';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db/client';
import { orders, orderOverrides } from '../src/db/schema/orders';
import { clients } from '../src/db/schema/clients';
import { listShipStationShipments } from '../src/connectors/store/shipstation';
import { ssV1Request } from '../src/lib/shipstation/v1-client';

/**
 * Mark genuinely marketplace-fulfilled ("Ext. Label") shipped orders.
 *
 * Problem: some shipped orders show "Missing shipment sync" when they are
 * actually externally fulfilled. Evidence (read-only): orders like Walmart
 * 200015108201081 / Amazon 113-3250447-6917837 are SHIPPED in ShipStation with
 * a carrier but have NO shipment AND NO fulfillment record anywhere — the
 * marketplace shipped them and no label was ever created. ShipStation does not
 * auto-set its `externallyFulfilled` flag for these, so PS-036's flag-based UI
 * check (correctly) doesn't show "Ext. Label", and they fall to the honest-but-
 * wrong "Missing shipment sync".
 *
 * The reliable, non-regressing distinction (vs PS-039 / order #1010, which had
 * an unsynced fulfillment → genuinely recoverable):
 *   - shipped + NO upstream shipment + NO upstream fulfillment  => EXTERNAL
 *   - shipped + HAS an upstream shipment OR fulfillment          => RECOVERABLE
 *     (leave as "Missing shipment sync"; the PS-039 backfill links it)
 *
 * On --apply (DJ-approved), EXTERNAL orders get `orders.externally_shipped =
 * true` (the same flag the operator "mark shipped external" action uses, which
 * the UI reads via flags.externallyShipped → "Ext. Label") plus an audit source
 * `order_overrides.externally_shipped_source = 'marketplace_fulfilled'`.
 *
 * SAFETY: dry-run by default. Reversible flag only — never deletes/rewrites
 * shipment or order history, never creates/voids labels, never buys postage,
 * never notifies marketplaces. Candidates are pre-filtered to shipped orders
 * with NO non-voided local shipment that aren't already flagged external.
 * main() runs only when invoked directly so the guard can import the classifier.
 */

const DEFAULT_DAYS = 30;
const DEFAULT_LOOKUP_TIMEOUT_MS = 25_000;

// ---------------------------------------------------------------------------
// Pure classifier — exported for the guard.
// ---------------------------------------------------------------------------

export type ExternalShippedClass =
  | 'external' // marketplace-fulfilled: no upstream shipment AND no fulfillment
  | 'recoverable' // has an upstream shipment/fulfillment → missing-sync, not external
  | 'lookup_failed' // upstream check errored → retry later
  | 'skip_not_shipped'
  | 'skip_already_external'
  | 'skip_has_local_shipment';

export interface ExternalShippedInput {
  orderStatus: string;
  alreadyExternal: boolean; // externally_shipped OR externally_fulfilled_verified
  hasNonVoidedLocalShipment: boolean;
  upstream: { lookupFailed: boolean; hasShipment: boolean; hasFulfillment: boolean };
}

export function classifyExternalShipped(input: ExternalShippedInput): ExternalShippedClass {
  // Shipped and cancelled both surface the external/local/missing badge in the
  // UI; awaiting orders never do. (Cancelled is opt-in at the candidate-query
  // level via --include-cancelled.)
  if (input.orderStatus !== 'shipped' && input.orderStatus !== 'cancelled') return 'skip_not_shipped';
  if (input.alreadyExternal) return 'skip_already_external';
  if (input.hasNonVoidedLocalShipment) return 'skip_has_local_shipment';
  if (input.upstream.lookupFailed) return 'lookup_failed';
  // Anything ShipStation can still produce/sync is NOT external — leave it for
  // the missing-shipment recovery / fulfillment backfill.
  if (input.upstream.hasShipment || input.upstream.hasFulfillment) return 'recoverable';
  return 'external';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function parsePositiveInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number`);
  return Math.floor(v);
}
function parseOrderNumbers(): string[] | null {
  const raw = argValue('order-numbers');
  if (!raw) return null;
  const list = raw.split(',').map((v) => v.trim()).filter(Boolean);
  return list.length ? list : null;
}

type Account = { label: string; apiKey?: string; apiSecret?: string };

async function loadAccountByClient(): Promise<{ main: Account; byClient: Map<number, Account> }> {
  const rows = await db
    .select({ id: clients.id, name: clients.name, ssApiKey: clients.ssApiKey, ssApiSecret: clients.ssApiSecret })
    .from(clients)
    .where(eq(clients.active, true));
  const byClient = new Map<number, Account>();
  for (const r of rows) {
    if (r.ssApiKey && r.ssApiSecret) {
      byClient.set(r.id, { label: `client:${r.name}`, apiKey: r.ssApiKey, apiSecret: r.ssApiSecret });
    }
  }
  return { main: { label: 'main' }, byClient };
}

async function checkUpstream(
  orderNumber: string,
  account: Account,
  opts: { timeoutMs?: number } = {},
): Promise<{ lookupFailed: boolean; hasShipment: boolean; hasFulfillment: boolean }> {
  let hasShipment = false;
  let hasFulfillment = false;
  let failed = false;
  try {
    const sh = await listShipStationShipments<{ shipments?: Array<{ voided?: boolean | null }> }>(
      new URLSearchParams({ orderNumber, pageSize: '5', page: '1' }),
      {
        apiKey: account.apiKey,
        apiSecret: account.apiSecret,
        dedupeKey: `extship:sh:${account.label}:${orderNumber}`,
        timeoutMs: opts.timeoutMs,
      },
    );
    // Only a NON-VOIDED shipment is recoverable — a voided label is dead.
    hasShipment = Array.isArray(sh.shipments) && sh.shipments.some((s) => s?.voided !== true);
  } catch {
    failed = true;
  }
  try {
    const fu = await ssV1Request<{ fulfillments?: Array<{ voided?: boolean | null; trackingNumber?: string | null }> }>(
      `/fulfillments?orderNumber=${encodeURIComponent(orderNumber)}&pageSize=5&page=1`,
      {
        apiKey: account.apiKey,
        apiSecret: account.apiSecret,
        dedupeKey: `extship:fu:${account.label}:${orderNumber}`,
        timeoutMs: opts.timeoutMs,
      },
    );
    // Only a NON-VOIDED fulfillment WITH a tracking number is recoverable
    // (mirrors the PS-039 fulfillment backfill's "active" definition). A
    // voided or untracked fulfillment has nothing to link → treat as external.
    hasFulfillment =
      Array.isArray(fu.fulfillments) &&
      fu.fulfillments.some((f) => f?.voided !== true && typeof f?.trackingNumber === 'string' && f.trackingNumber.trim() !== '');
  } catch {
    failed = failed && true; // only fully failed if BOTH calls threw
    if (!hasShipment) failed = true;
  }
  // Treat as lookup_failed only when we learned nothing at all.
  return { lookupFailed: failed && !hasShipment && !hasFulfillment, hasShipment, hasFulfillment };
}

function printUsage(): void {
  console.log(`
Mark marketplace-fulfilled shipped orders as external ("Ext. Label")

Usage:
  npm run shipstation:external-shipped:dry-run
  npm run shipstation:external-shipped:dry-run -- --days 7 --limit 50
  npm run shipstation:external-shipped:dry-run -- --order-numbers 200015108201081,113-3250447-6917837
  npm run shipstation:external-shipped:apply -- --order-numbers 200015108201081   # DJ-approved only

Options:
  --days <n>            Look back window on order_date. Default: ${DEFAULT_DAYS}.
  --limit <n>           Max candidate orders to scan. Default: 200.
  --order-numbers a,b   Restrict to specific order numbers.
  --apply               Set externally_shipped=true on EXTERNAL orders. OFF by default.

Safety: dry-run unless --apply. Reversible flag only; never deletes/rewrites
shipment or order history, never creates/voids labels, never notifies marketplaces.
`);
}

export interface ExternalShippedReconcileOptions {
  apply?: boolean;
  includeCancelled?: boolean;
  days?: number;
  limit?: number;
  orderNumbers?: string[] | null;
  lookupTimeoutMs?: number;
  timeBudgetMs?: number;
}

export async function runExternalShippedReconcile(
  options: ExternalShippedReconcileOptions = {},
): Promise<{
  missingLocalUnflagged: number;
  alreadyFlaggedExternal: number;
  scanned: number;
  classifiedExternal: number;
  classifiedRecoverable: number;
  lookupFailures: number;
  flagged: number;
  timeBudgetExhausted: boolean;
}> {
  const apply = options.apply === true;
  const includeCancelled = options.includeCancelled === true;
  const days = options.days ?? DEFAULT_DAYS;
  const limit = options.limit ?? 200;
  const orderNumbersFilter = options.orderNumbers ?? null;
  const statuses = includeCancelled ? ['shipped', 'cancelled'] : ['shipped'];
  const lookupTimeoutMs = Math.max(1_000, options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS);
  const timeBudgetMs = options.timeBudgetMs == null ? null : Math.max(10_000, options.timeBudgetMs);
  const startedAtMs = Date.now();
  const isTimeBudgetExhausted = () =>
    timeBudgetMs != null && Date.now() - startedAtMs >= timeBudgetMs;

  console.log(`\n[external-shipped] PS-056 ${apply ? 'APPLY' : 'DRY RUN'} — statuses=${statuses.join(',')} days=${days} limit=${limit}${orderNumbersFilter ? ` orderNumbers=${orderNumbersFilter.join(',')}` : ''}`);

  // Candidates: shipped, not already external, with NO non-voided local shipment.
  const noLocalShipment = sql`not exists (
    select 1 from shipments s
    where (s.order_id = ${orders.id} or s.order_number = ${orders.orderNumber})
      and coalesce(s.voided, false) = false
  )`;
  const scopedMissingLocal = orderNumbersFilter
    ? and(
        inArray(orders.orderStatus, statuses),
        noLocalShipment,
        inArray(orders.orderNumber, orderNumbersFilter),
      )
    : and(
        inArray(orders.orderStatus, statuses),
        noLocalShipment,
        sql`${orders.orderDate} >= now() - interval '${sql.raw(String(days))} days'`,
      );
  const unflaggedMissingLocalWhere = and(
    scopedMissingLocal,
    eq(orders.externallyShipped, false),
    eq(orders.externallyFulfilledVerified, false),
  );
  const alreadyFlaggedExternalWhere = and(
    scopedMissingLocal,
    or(eq(orders.externallyShipped, true), eq(orders.externallyFulfilledVerified, true)),
  );

  const [missingLocalUnflaggedRow, alreadyFlaggedExternalRow] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(orders).where(unflaggedMissingLocalWhere),
    db.select({ count: sql<number>`count(*)::int` }).from(orders).where(alreadyFlaggedExternalWhere),
  ]);

  const candidates = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, clientId: orders.clientId, storeId: orders.storeId, orderStatus: orders.orderStatus })
    .from(orders)
    .where(unflaggedMissingLocalWhere)
    .orderBy(desc(orders.orderDate))
    .limit(limit);

  const { main, byClient } = await loadAccountByClient();

  const report = {
    missingLocalUnflagged: missingLocalUnflaggedRow[0]?.count ?? 0,
    alreadyFlaggedExternal: alreadyFlaggedExternalRow[0]?.count ?? 0,
    scanned: 0,
    classifiedExternal: 0,
    classifiedRecoverable: 0,
    lookupFailures: 0,
    flagged: 0,
    timeBudgetExhausted: false,
    samples: [] as Array<{ orderNumber: string | null; clientId: number | null; storeId: number | null; classification: ExternalShippedClass }> };

  for (const o of candidates) {
    if (isTimeBudgetExhausted()) {
      report.timeBudgetExhausted = true;
      break;
    }
    const account = (o.clientId != null && byClient.get(o.clientId)) || main;
    const upstream = o.orderNumber
      ? await checkUpstream(o.orderNumber, account, { timeoutMs: lookupTimeoutMs })
      : { lookupFailed: false, hasShipment: false, hasFulfillment: false };
    report.scanned += 1;

    const classification = classifyExternalShipped({
      orderStatus: o.orderStatus,
      alreadyExternal: false, // pre-filtered
      hasNonVoidedLocalShipment: false, // pre-filtered
      upstream,
    });

    if (classification === 'external') report.classifiedExternal += 1;
    else if (classification === 'recoverable') report.classifiedRecoverable += 1;
    else if (classification === 'lookup_failed') report.lookupFailures += 1;

    if (report.samples.length < 50) {
      report.samples.push({ orderNumber: o.orderNumber, clientId: o.clientId, storeId: o.storeId, classification });
    }

    if (apply && classification === 'external') {
      // Per user override unlock shipped data on 2026-07-02: automatic apply
      // only sets the reversible external-shipped flag for orders proven to
      // have no upstream shipment/fulfillment. It never mutates shipments.
      await db.update(orders).set({ externallyShipped: true, updatedAt: new Date() }).where(eq(orders.id, o.id));
      await db
        .insert(orderOverrides)
        .values({ orderId: o.id, externallyShippedSource: 'marketplace_fulfilled', updatedAt: new Date() })
        .onConflictDoUpdate({ target: orderOverrides.orderId, set: { externallyShippedSource: 'marketplace_fulfilled', updatedAt: new Date() } });
      report.flagged += 1;
    }
  }

  console.log('\n[external-shipped] summary');
  console.table([{
    missing_local_unflagged: report.missingLocalUnflagged,
    already_flagged_external: report.alreadyFlaggedExternal,
    scanned: report.scanned,
    classified_external: report.classifiedExternal,
    classified_recoverable: report.classifiedRecoverable,
    lookup_failures: report.lookupFailures,
    flagged: report.flagged,
    time_budget_exhausted: report.timeBudgetExhausted,
  }]);
  if (report.samples.length) {
    console.log('\nSamples:');
    console.table(report.samples);
  }
  console.log(
    apply
      ? `\n[external-shipped] applied: flagged ${report.flagged} order(s) externally_shipped=true (marketplace_fulfilled).`
      : '\nDry run only. Re-run with --apply (DJ-approved) after review.',
  );

  return {
    missingLocalUnflagged: report.missingLocalUnflagged,
    alreadyFlaggedExternal: report.alreadyFlaggedExternal,
    scanned: report.scanned,
    classifiedExternal: report.classifiedExternal,
    classifiedRecoverable: report.classifiedRecoverable,
    lookupFailures: report.lookupFailures,
    flagged: report.flagged,
    timeBudgetExhausted: report.timeBudgetExhausted,
  };
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) return printUsage();

  await runExternalShippedReconcile({
    apply: hasFlag('apply'),
    includeCancelled: hasFlag('include-cancelled'),
    days: parsePositiveInt('days', DEFAULT_DAYS),
    limit: parsePositiveInt('limit', 200),
    orderNumbers: parseOrderNumbers(),
  });
}

const invokedDirectly = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
