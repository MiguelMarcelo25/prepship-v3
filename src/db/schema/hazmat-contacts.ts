import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clients } from './clients.js';

/**
 * Reusable dangerous-goods emergency contacts.
 *
 * The DG emergency contact is retyped on every hazmat automation action and on
 * every manual declaration, which is both tedious and a correctness risk: a
 * mistyped emergency phone number is what a carrier calls during an incident.
 *
 * clientId is NULLABLE and that is the whole design. A null contact is shared
 * across every client -- the common case, because the emergency contact is
 * legally the shipper's, and the shipper here is one company. Tagging a
 * contact to a client covers the brand that supplies its own.
 *
 * Deliberately NOT referenced by automation rules. The hazmat action config
 * stores the name and phone as literal strings, and published rule versions
 * are immutable; if a rule pointed at a contact id, editing that contact would
 * silently change what an already-published rule declares on real shipments.
 * Picking from this table copies the values in. That also means deleting a
 * contact can never break a live rule.
 */
export const hazmatContacts = pgTable(
  'hazmat_contacts',
  {
    id: serial().primaryKey(),
    /** Null = available to every client. */
    clientId: integer().references(() => clients.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    phone: text().notNull(),
    createdBy: text(),
    updatedBy: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    /** Soft delete. Keeps the row addressable from audit trails that named it. */
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('hazmat_contacts_scope_idx').on(t.clientId, t.archivedAt),
    // coalesce, because NULL client ids would otherwise never collide with each
    // other and the shared list could accumulate duplicates.
    uniqueIndex('hazmat_contacts_unique_live')
      .on(sql`coalesce(${t.clientId}, 0)`, sql`lower(${t.name})`, t.phone)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export type HazmatContactRow = typeof hazmatContacts.$inferSelect;
