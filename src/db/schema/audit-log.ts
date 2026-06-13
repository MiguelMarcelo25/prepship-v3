import { index, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * PS-234 — append-only audit log.
 *
 * One immutable row per business-critical mutation (credentials, labels, orders
 * incl. ?force=1 overrides, billing, settings). It records WHO did WHAT to WHICH
 * resource, WHEN, and from where — the forensic trail the enterprise-readiness
 * audit (AUDIT_LOGGING_MATRIX.md) requires.
 *
 * APPEND-ONLY is enforced at the DB level (a BEFORE UPDATE OR DELETE trigger that
 * raises — see ensureAuditLogSchema / drizzle/0044_audit_log.sql), so even the
 * backend owner connection cannot rewrite history. `details` is jsonb and MUST be
 * routed through redactAuditDetails() so no raw secret/token/credential ever lands
 * here. Column casing is snake_case (project drizzle convention).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: serial().primaryKey(),
    ts: timestamp({ withTimezone: true }).defaultNow().notNull(),
    eventType: text().notNull(),
    actorId: text(),
    actorEmail: text(),
    resourceType: text().notNull(),
    resourceId: text(),
    action: text().notNull(),
    details: jsonb(),
    ip: text(),
  },
  (t) => [
    index('audit_log_resource_idx').on(t.resourceType, t.resourceId),
    index('audit_log_ts_idx').on(t.ts.desc()),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
