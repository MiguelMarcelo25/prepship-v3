import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { hazmatContacts, type HazmatContactRow } from '../../db/schema/hazmat-contacts.js';

/**
 * Canonical owner of the dangerous-goods contact book.
 *
 * Routes validate request shape and call in here; they do not decide what is
 * visible, what collides, or what may be deleted.
 */

export class HazmatContactConflictError extends Error {
  readonly code = 'HAZMAT_CONTACT_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'HazmatContactConflictError';
  }
}

export class HazmatContactNotFoundError extends Error {
  readonly code = 'HAZMAT_CONTACT_NOT_FOUND';
  constructor() {
    super('Contact not found');
    this.name = 'HazmatContactNotFoundError';
  }
}

export interface HazmatContactDto {
  id: number;
  clientId: number | null;
  name: string;
  phone: string;
  /** True when this contact is available to every client. */
  shared: boolean;
}

function toDto(row: HazmatContactRow): HazmatContactDto {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    phone: row.phone,
    shared: row.clientId === null,
  };
}

/**
 * Contacts usable by a rule scoped to `clientId`: that client's own, plus every
 * shared one. Passing null returns only the shared contacts, which is correct
 * for a rule with no client condition -- offering another client's contact
 * there would put that client's phone number on an unrelated shipment.
 *
 * Client-specific entries sort first so the more specific choice is the one in
 * reach, then by name for a stable order.
 */
export async function listHazmatContacts(clientId: number | null): Promise<HazmatContactDto[]> {
  const visible = clientId === null
    ? isNull(hazmatContacts.clientId)
    : or(isNull(hazmatContacts.clientId), eq(hazmatContacts.clientId, clientId));

  const rows = await db
    .select()
    .from(hazmatContacts)
    .where(and(isNull(hazmatContacts.archivedAt), visible))
    .orderBy(
      asc(sql`case when ${hazmatContacts.clientId} is null then 1 else 0 end`),
      asc(sql`lower(${hazmatContacts.name})`),
    );

  return rows.map(toDto);
}

async function assertNoLiveDuplicate(
  clientId: number | null,
  name: string,
  phone: string,
  excludeId?: number,
): Promise<void> {
  // Mirrors hazmat_contacts_unique_live so the caller gets a readable message
  // instead of a raw constraint violation. The index is still the authority.
  const [clash] = await db
    .select({ id: hazmatContacts.id })
    .from(hazmatContacts)
    .where(and(
      isNull(hazmatContacts.archivedAt),
      clientId === null ? isNull(hazmatContacts.clientId) : eq(hazmatContacts.clientId, clientId),
      sql`lower(${hazmatContacts.name}) = lower(${name})`,
      eq(hazmatContacts.phone, phone),
      excludeId ? sql`${hazmatContacts.id} <> ${excludeId}` : sql`true`,
    ))
    .limit(1);
  if (clash) {
    throw new HazmatContactConflictError('A contact with this name and phone already exists here');
  }
}

/**
 * assertNoLiveDuplicate is check-then-act, so two concurrent creates can both
 * pass it and one will hit hazmat_contacts_unique_live. The pre-check exists
 * only to produce a readable message in the common case; the index is the
 * authority, and its violation is translated to the same error here rather
 * than escaping as a raw driver failure.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

export async function createHazmatContact(input: {
  clientId: number | null;
  name: string;
  phone: string;
  actor: string;
}): Promise<HazmatContactDto> {
  await assertNoLiveDuplicate(input.clientId, input.name, input.phone);
  try {
    const [row] = await db
      .insert(hazmatContacts)
      .values({
        clientId: input.clientId,
        name: input.name,
        phone: input.phone,
        createdBy: input.actor,
        updatedBy: input.actor,
      })
      .returning();
    if (!row) throw new HazmatContactConflictError('Contact could not be saved');
    return toDto(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HazmatContactConflictError('A contact with this name and phone already exists here');
    }
    throw error;
  }
}

/**
 * Edits a contact in place.
 *
 * Rules that already copied these values keep what they copied -- see the note
 * on the schema. This changes what future picks insert, not what any published
 * rule declares.
 */
export async function updateHazmatContact(input: {
  id: number;
  clientId: number | null;
  name: string;
  phone: string;
  actor: string;
}): Promise<HazmatContactDto> {
  await assertNoLiveDuplicate(input.clientId, input.name, input.phone, input.id);
  try {
    const [row] = await db
      .update(hazmatContacts)
      .set({
        clientId: input.clientId,
        name: input.name,
        phone: input.phone,
        updatedBy: input.actor,
        updatedAt: new Date(),
      })
      .where(and(eq(hazmatContacts.id, input.id), isNull(hazmatContacts.archivedAt)))
      .returning();
    if (!row) throw new HazmatContactNotFoundError();
    return toDto(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HazmatContactConflictError('A contact with this name and phone already exists here');
    }
    throw error;
  }
}

/**
 * Soft delete. The row stays so an audit trail that named this contact still
 * resolves, and the partial unique index frees the name for reuse.
 */
export async function deleteHazmatContact(input: { id: number; actor: string }): Promise<{ id: number }> {
  const [row] = await db
    .update(hazmatContacts)
    .set({ archivedAt: new Date(), updatedBy: input.actor })
    .where(and(eq(hazmatContacts.id, input.id), isNull(hazmatContacts.archivedAt)))
    .returning({ id: hazmatContacts.id });
  if (!row) throw new HazmatContactNotFoundError();
  return row;
}
