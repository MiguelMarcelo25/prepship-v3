// Carrier harness — deterministic TEST-order factory (Slice 2).
// Plan: ~/.claude/plans/zany-spinning-hennessy.md
//
// Two layers:
//   1. PURE seed builder (buildCarrierTestOrderSeed / assertSeedIsSafe) — no DB,
//      no network. Lets the harness self-check validate the order shape offline
//      and lets every DB insert be safety-checked BEFORE it touches the database.
//   2. DB ops (ensureHarnessTestClient / createCarrierTestOrder / cleanup) that run
//      against the real Postgres via a `postgres` sql client passed in by the runner.
//
// SAFETY INVARIANTS (the whole point):
//   - orders live under a dedicated clients.is_test=true row (__CARRIER_HARNESS__),
//     which the app already treats as "never real postage / never billing / never
//     inventory / excluded from stats".
//   - source_provider = 'internal' and external_order_id is NULL — so the marketplace
//     confirmation path (outbox + Walmart immediate-confirm) can never fire.
//   - order_number is prefixed HARNESS- so cleanup can find ONLY harness rows.
//   - SKU is TEST-CARRIER-… so the frontend isTestOrder() also lights up.
//   - cleanup NEVER deletes a shipped/cancelled order (lockdown) — it reports them.

export const HARNESS_MARKER = 'HARNESS-';
export const HARNESS_CLIENT_NAME = '__CARRIER_HARNESS__';
export const HARNESS_SOURCE = 'internal';
const REAL_MARKETPLACE_PREFIX = /^(walmart|ebay|amazon|shipstation)-/i;

export interface CarrierTestOrderInput {
  provider: string;
  serviceCode: string;
  /** deterministic disambiguator when the same provider+service is seeded twice */
  seq?: number;
}

export interface CarrierTestOrderShipTo {
  name: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
}

export interface CarrierTestOrderSeed {
  orderNumber: string;
  sourceProvider: string;
  externalOrderId: string | null;
  orderStatus: string;
  sku: string;
  shipTo: CarrierTestOrderShipTo;
  weightOz: number;
  dims: { l: number; w: number; h: number };
  items: unknown[];
  raw: Record<string, unknown>;
}

function normalizeProvider(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function slug(value: string): string {
  return (
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'svc'
  );
}

/** Deterministic, DB-free order seed. Same inputs → same row. */
export function buildCarrierTestOrderSeed(input: CarrierTestOrderInput): CarrierTestOrderSeed {
  const provider = normalizeProvider(input.provider);
  const svc = slug(input.serviceCode);
  const seq = Number.isFinite(input.seq) ? Math.trunc(input.seq as number) : 1;
  const sku = `TEST-CARRIER-${provider}-${svc}`.toUpperCase();
  const orderNumber = `${HARNESS_MARKER}${provider}-${svc}-${seq}`.toUpperCase();
  const shipTo: CarrierTestOrderShipTo = {
    name: 'Carrier Harness Tester',
    street1: '417 Montgomery St',
    street2: '',
    city: 'San Francisco',
    state: 'CA',
    zip: '94104',
    country: 'US',
    phone: '4150000000',
  };
  return {
    orderNumber,
    sourceProvider: HARNESS_SOURCE,
    externalOrderId: null,
    orderStatus: 'awaiting_shipment',
    sku,
    shipTo,
    weightOz: 16,
    dims: { l: 8, w: 6, h: 4 },
    items: [{ sku, name: `Carrier harness test item (${provider})`, quantity: 1 }],
    raw: { shipTo, harness: true, provider, serviceCode: input.serviceCode },
  };
}

export class CarrierTestOrderSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CarrierTestOrderSafetyError';
  }
}

/** Throw if a seed could ever notify a marketplace or escape cleanup. Run before every insert. */
export function assertSeedIsSafe(seed: CarrierTestOrderSeed): void {
  if (seed.sourceProvider !== HARNESS_SOURCE) {
    throw new CarrierTestOrderSafetyError(`harness order must use source_provider='${HARNESS_SOURCE}'`);
  }
  if (seed.externalOrderId && REAL_MARKETPLACE_PREFIX.test(seed.externalOrderId)) {
    throw new CarrierTestOrderSafetyError(`harness order must not carry a marketplace external id: ${seed.externalOrderId}`);
  }
  if (!seed.orderNumber.startsWith(HARNESS_MARKER)) {
    throw new CarrierTestOrderSafetyError(`harness order_number must start with ${HARNESS_MARKER} (cleanup scope)`);
  }
  if (!/^TEST-/.test(seed.sku)) {
    throw new CarrierTestOrderSafetyError('harness SKU must start with TEST- (frontend isTestOrder gate)');
  }
}

type Sql = any;

/** Find-or-create the dedicated is_test harness client. Returns its id. */
export async function ensureHarnessTestClient(sql: Sql): Promise<number> {
  const existing = (await sql`
    SELECT id FROM clients WHERE name = ${HARNESS_CLIENT_NAME} LIMIT 1
  `) as Array<{ id: number }>;
  if (existing[0]?.id) {
    // Belt-and-suspenders: ensure it stays flagged is_test.
    await sql`UPDATE clients SET is_test = true, updated_at = NOW() WHERE id = ${existing[0].id}`;
    return existing[0].id;
  }
  const created = (await sql`
    INSERT INTO clients (name, is_test, active, updated_at)
    VALUES (${HARNESS_CLIENT_NAME}, true, true, NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return created[0].id;
}

/** Insert a deterministic awaiting_shipment harness order + dims override. */
export async function createCarrierTestOrder(
  sql: Sql,
  input: CarrierTestOrderInput & { clientId?: number },
): Promise<{ orderId: number; seed: CarrierTestOrderSeed; clientId: number }> {
  const seed = buildCarrierTestOrderSeed(input);
  assertSeedIsSafe(seed); // refuse before touching the DB
  const clientId = input.clientId ?? (await ensureHarnessTestClient(sql));

  const rows = (await sql`
    INSERT INTO orders (
      client_id, order_number, order_status, source_provider, external_order_id,
      ship_to_name, ship_to_city, ship_to_state, ship_to_postal_code,
      weight_oz, items, raw, order_date, updated_at
    ) VALUES (
      ${clientId}, ${seed.orderNumber}, ${seed.orderStatus}, ${seed.sourceProvider}, ${seed.externalOrderId},
      ${seed.shipTo.name}, ${seed.shipTo.city}, ${seed.shipTo.state}, ${seed.shipTo.zip},
      ${seed.weightOz}, ${sql.json(seed.items)}, ${sql.json(seed.raw)}, NOW(), NOW()
    )
    ON CONFLICT (external_order_id) DO NOTHING
    RETURNING id
  `) as Array<{ id: number }>;

  let orderId = rows[0]?.id;
  if (!orderId) {
    // external_order_id is NULL so ON CONFLICT cannot collide; re-find by order_number+client just in case.
    const found = (await sql`
      SELECT id FROM orders WHERE order_number = ${seed.orderNumber} AND client_id = ${clientId} ORDER BY id DESC LIMIT 1
    `) as Array<{ id: number }>;
    orderId = found[0]?.id;
  }
  if (!orderId) throw new CarrierTestOrderSafetyError('failed to create harness order');

  await sql`
    INSERT INTO order_overrides (order_id, rate_weight_oz, rate_dims_l, rate_dims_w, rate_dims_h, updated_at)
    VALUES (${orderId}, ${seed.weightOz}, ${seed.dims.l}, ${seed.dims.w}, ${seed.dims.h}, NOW())
    ON CONFLICT (order_id) DO UPDATE SET
      rate_weight_oz = EXCLUDED.rate_weight_oz,
      rate_dims_l = EXCLUDED.rate_dims_l, rate_dims_w = EXCLUDED.rate_dims_w, rate_dims_h = EXCLUDED.rate_dims_h,
      updated_at = NOW()
  `;
  return { orderId, seed, clientId };
}

/**
 * Delete ONLY harness orders that are still safe to delete. NEVER touches a
 * shipped/cancelled order (lockdown) — those are reported back, not mutated.
 */
export async function cleanupCarrierTestOrders(
  sql: Sql,
): Promise<{ deleted: number; skippedLocked: number }> {
  const clientRows = (await sql`SELECT id FROM clients WHERE name = ${HARNESS_CLIENT_NAME} LIMIT 1`) as Array<{ id: number }>;
  const clientId = clientRows[0]?.id;
  if (!clientId) return { deleted: 0, skippedLocked: 0 };

  const lockedRows = (await sql`
    SELECT count(*)::int AS n FROM orders
    WHERE client_id = ${clientId}
      AND order_number LIKE ${HARNESS_MARKER + '%'}
      AND order_status IN ('shipped', 'cancelled')
  `) as Array<{ n: number }>;
  const skippedLocked = lockedRows[0]?.n ?? 0;

  const ids = (await sql`
    SELECT id FROM orders
    WHERE client_id = ${clientId}
      AND order_number LIKE ${HARNESS_MARKER + '%'}
      AND order_status NOT IN ('shipped', 'cancelled')
  `) as Array<{ id: number }>;
  let deleted = 0;
  for (const { id } of ids) {
    await sql`DELETE FROM order_overrides WHERE order_id = ${id}`;
    const res = (await sql`DELETE FROM orders WHERE id = ${id} AND order_status NOT IN ('shipped','cancelled') RETURNING id`) as Array<{ id: number }>;
    deleted += res.length;
  }
  return { deleted, skippedLocked };
}
