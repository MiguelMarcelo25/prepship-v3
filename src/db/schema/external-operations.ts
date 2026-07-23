import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * PS-423 canonical journal for provider mutations.
 *
 * Connectors translate provider payloads; they do not decide whether a
 * mutation may be retried. This row is the durable authority for dispatch,
 * ambiguous outcomes, provider receipts, and atomic local consumption.
 */
export const externalOperations = pgTable(
  'external_operations',
  {
    id: serial().primaryKey(),
    operationKey: text().notNull(),
    kind: text().notNull(),
    provider: text().notNull(),
    subjectType: text().notNull(),
    subjectId: text().notNull(),
    semanticGeneration: integer().default(1).notNull(),
    requestHash: text().notNull(),
    idempotencyKey: text().notNull(),
    state: text().default('prepared').notNull(),
    generation: integer().default(0).notNull(),
    leaseToken: text(),
    leaseExpiresAt: timestamp({ withTimezone: true }),
    attemptCount: integer().default(0).notNull(),
    providerOperationId: text(),
    providerResultId: text(),
    providerReceipt: jsonb().$type<Record<string, unknown> | null>(),
    localResult: jsonb().$type<Record<string, unknown> | null>(),
    lastError: text(),
    resolutionNote: text(),
    resolvedBy: text(),
    preparedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    dispatchedAt: timestamp({ withTimezone: true }),
    receiptRecordedAt: timestamp({ withTimezone: true }),
    consumedAt: timestamp({ withTimezone: true }),
    cancellationRequestedAt: timestamp({ withTimezone: true }),
    cancellationAcknowledgedAt: timestamp({ withTimezone: true }),
    resolvedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('external_operations_key_unq').on(t.operationKey),
    uniqueIndex('external_operations_idempotency_unq').on(t.idempotencyKey),
    index('external_operations_state_lease_idx').on(t.state, t.leaseExpiresAt),
    index('external_operations_subject_idx').on(t.subjectType, t.subjectId, t.kind),
    check('external_operations_semantic_generation_chk', sql`${t.semanticGeneration} > 0`),
    check('external_operations_generation_chk', sql`${t.generation} >= 0`),
    check(
      'external_operations_state_chk',
      sql`${t.state} in (
        'prepared',
        'in_flight',
        'receipt_recorded',
        'consumed',
        'failed_pre_dispatch',
        'reconcile_required'
      )`,
    ),
  ],
);

export type ExternalOperation = typeof externalOperations.$inferSelect;
export type NewExternalOperation = typeof externalOperations.$inferInsert;
