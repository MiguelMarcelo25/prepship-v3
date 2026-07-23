import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';

/**
 * Canonical client identity used by shipping quote, purchase, and recovery
 * boundaries. Older orders can lack orders.client_id, so their store mapping is
 * the only durable tenant owner available.
 * Per user override unlock shipped data on 2026-07-22: recovery persists this
 * resolved identity instead of the nullable legacy order field.
 */
export async function resolveShippingClientId(input: {
  clientId: number | null;
  storeId: number | null;
}): Promise<number | null> {
  if (input.clientId != null) return input.clientId;
  if (input.storeId == null) return null;
  const [match] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(sql`${clients.storeIds} @> ${[input.storeId]}::integer[]`)
    .limit(1);
  return match?.id ?? null;
}
