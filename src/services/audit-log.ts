/**
 * audit-log.ts — PS-234 append-only audit event writer.
 *
 * recordAuditEvent() is the single owner of "write a durable audit row". It is
 * BEST-EFFORT: a failed audit insert is logged and swallowed so it can NEVER break
 * the business mutation it is recording. Every `details` payload is routed through
 * redactAuditDetails() so secret/token/credential values never land in the table —
 * only changed-field names + masked metadata (AUDIT_LOGGING_MATRIX.md control:
 * "never store raw credentials").
 *
 * Append-only is enforced at the DB level by ensureAuditLogSchema() (a trigger that
 * blocks UPDATE/DELETE for every role), mirrored by drizzle/0044_audit_log.sql.
 */
import type { Context } from 'hono';
import { db, sql as pg } from '../db/client';
import { auditLog } from '../db/schema/audit-log';

let schemaEnsured: Promise<void> | null = null;

export async function ensureAuditLogSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS audit_log (
        id serial PRIMARY KEY,
        ts timestamptz NOT NULL DEFAULT now(),
        event_type text NOT NULL,
        actor_id text,
        actor_email text,
        resource_type text NOT NULL,
        resource_id text,
        action text NOT NULL,
        details jsonb,
        ip text
      )
    `;
    await pg`CREATE INDEX IF NOT EXISTS audit_log_resource_idx ON audit_log (resource_type, resource_id)`;
    await pg`CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC)`;
    // RLS posture matches the project model (backend = postgres owner bypasses
    // RLS; no frontend direct access). Enable RLS with no policy → non-owner denied.
    await pg`ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY`;
    // Append-only: block UPDATE/DELETE at the DB level for EVERY role (including
    // the backend owner) — a stronger guarantee than role grants alone.
    await pg`
      CREATE OR REPLACE FUNCTION audit_log_block_mutations() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `;
    await pg`DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log`;
    await pg`
      CREATE TRIGGER audit_log_no_update_delete
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutations()
    `;
    // Defense in depth: deny mutating grants to non-owner roles (RLS already denies).
    await pg`REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

export type AuditActor = {
  actorId?: string | null;
  actorEmail?: string | null;
  ip?: string | null;
};

export type AuditEventInput = AuditActor & {
  eventType: string;
  resourceType: string;
  resourceId?: string | number | null;
  action: string;
  details?: Record<string, unknown> | null;
};

// Field names whose VALUES must never be persisted to the audit log.
const SECRET_KEY_RE =
  /(secret|token|api[_-]?key|password|passwd|authorization|bearer|credential|private[_-]?key|client[_-]?secret)/i;

export function redactAuditDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAuditDetails(item));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redactAuditDetails(nested);
  }
  return out;
}

/** Pull the actor (verified JWT subject/email) + client IP off a Hono request. */
export function auditActorFromContext(c: Context): AuditActor {
  const forwarded = c.req.header('x-forwarded-for');
  return {
    actorId: (c.get('userId' as never) as string | undefined) ?? null,
    actorEmail: (c.get('email' as never) as string | undefined) ?? null,
    ip:
      (forwarded ? forwarded.split(',')[0]?.trim() : undefined) ||
      c.req.header('x-real-ip') ||
      null,
  };
}

/**
 * Write one append-only audit row. Best-effort — never throws into the caller.
 */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await ensureAuditLogSchema();
    await db.insert(auditLog).values({
      eventType: event.eventType,
      actorId: event.actorId ?? null,
      actorEmail: event.actorEmail ?? null,
      resourceType: event.resourceType,
      resourceId: event.resourceId == null ? null : String(event.resourceId),
      action: event.action,
      details: event.details
        ? (redactAuditDetails(event.details) as Record<string, unknown>)
        : null,
      ip: event.ip ?? null,
    });
  } catch (err) {
    // A failed audit write MUST NOT break the business mutation it records.
    console.warn(
      '[audit-log] failed to record event',
      event.eventType,
      event.action,
      err instanceof Error ? err.message : err,
    );
  }
}
