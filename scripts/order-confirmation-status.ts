// Read-only diagnostic: show the marketplace-confirmation lifecycle for one order.
//
// SAFETY: SELECT-only. NEVER updates/deletes orders, shipments, or outbox rows.
// Prints confirmation state + provider + last error (no customer PII, no tracking,
// no secrets) so we can see WHY a marketplace wasn't notified.
//
//   npm run order:confirm-status -- <orderId>
import postgres from 'postgres';

async function main(): Promise<void> {
  const orderId = Number(process.argv[2]);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    console.error('Usage: npm run order:confirm-status -- <orderId>');
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 });
  try {
    const [order] = await sql<Array<Record<string, unknown>>>`
      SELECT id, order_number, external_order_id, source_provider, source_order_id,
             source_order_number, order_status, canonical_status
      FROM orders WHERE id = ${orderId} LIMIT 1
    `;
    console.log('\n=== ORDER ===');
    console.log(order ?? '(order not found)');

    const shipments = await sql<Array<Record<string, unknown>>>`
      SELECT id, carrier_provider, carrier_account_id, confirmation_provider,
             confirmation_status, confirmation_attempts, confirmation_last_error,
             marketplace_confirmed_at, created_at
      FROM shipments WHERE order_id = ${orderId} ORDER BY id DESC
    `;
    console.log('\n=== SHIPMENTS ===');
    for (const s of shipments) console.log(s);
    if (!shipments.length) console.log('(no shipment rows)');

    const outbox = await sql<Array<Record<string, unknown>>>`
      SELECT id, shipment_id, event_type, provider, status, attempts,
             dedupe_key, last_error, next_run_at, updated_at
      FROM fulfillment_outbox WHERE order_id = ${orderId} ORDER BY id DESC
    `;
    console.log('\n=== FULFILLMENT OUTBOX (confirmation queue) ===');
    for (const o of outbox) console.log(o);
    if (!outbox.length) console.log('(no outbox rows — confirmation was never enqueued)');
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('diagnostic failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
