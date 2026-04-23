import { pgTable, text } from 'drizzle-orm/pg-core';

// v2-parity: sync_meta KV. v4 uses the general `settings` table for the same
// purpose, but v2 integrations may look for this specific table name. Kept as
// a separate table — writes to sync-related watermarks land here AND in
// settings (see services/order-sync.ts) so both shapes stay consistent.
export const syncMeta = pgTable('sync_meta', {
  key: text().primaryKey(),
  value: text(),
});

export type SyncMeta = typeof syncMeta.$inferSelect;
export type NewSyncMeta = typeof syncMeta.$inferInsert;
