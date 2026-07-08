import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';

// 60s TTL cache of the test-client id set (the PS-233 display flag /orders
// stamps on every row). It was re-queried on EVERY /orders request; test-client
// membership changes rarely (an admin toggle), so a short TTL is the whole
// invalidation story. Display-only consumer — a stale minute is harmless.
const TEST_CLIENT_IDS_TTL_MS = 60_000;
let cached: { at: number; ids: Set<number> } | null = null;

export async function getTestClientIds(): Promise<Set<number>> {
  if (cached && Date.now() - cached.at < TEST_CLIENT_IDS_TTL_MS) return cached.ids;
  const rows = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.isTest, true));
  cached = { at: Date.now(), ids: new Set(rows.map((row) => row.id)) };
  return cached.ids;
}
