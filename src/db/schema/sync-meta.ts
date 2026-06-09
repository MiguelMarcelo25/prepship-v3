import { pgTable, text } from 'drizzle-orm/pg-core';

// v2-parity: sync_meta KV. v4 uses the general `settings` table for the same purpose.
// PS-153 audit (2026-06-09): this table is CODE-DEAD — no Drizzle reference and no raw-SQL `sync_meta`
// access anywhere in src/ (the prior comment claiming services/order-sync.ts writes here was stale).
// RETAINED ON PURPOSE: the `sync_meta` DB table still exists, and drizzle-kit generate diffs schema vs
// DB — deleting this definition would arm the next migration to DROP the table (data loss). Do NOT
// remove this without a deliberate, approval-gated DROP migration. Guard: scripts/ps-153-dead-symbols-guard.ts.
export const syncMeta = pgTable('sync_meta', {
  key: text().primaryKey(),
  value: text(),
});

export type SyncMeta = typeof syncMeta.$inferSelect;
export type NewSyncMeta = typeof syncMeta.$inferInsert;
