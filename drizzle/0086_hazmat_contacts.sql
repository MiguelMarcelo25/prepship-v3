-- Reusable dangerous-goods emergency contacts.
--
-- The DG emergency contact was retyped on every hazmat automation action and
-- every manual declaration. A mistyped emergency phone is what a carrier calls
-- during an incident, so retyping it is a correctness risk, not just tedium.
--
-- client_id is nullable on purpose: NULL means the contact is available to
-- every client, which is the common case because the emergency contact is
-- legally the shipper's. A client_id tags a contact to one brand that supplies
-- its own.
--
-- Nothing references this table. The automation action config stores the name
-- and phone as literal strings and published versions are immutable -- a
-- foreign key would let editing a contact silently change what an
-- already-published rule declares on real shipments. Selecting a contact
-- copies its values, so deleting one can never break a live rule.

CREATE TABLE IF NOT EXISTS hazmat_contacts (
  id serial PRIMARY KEY,
  client_id integer REFERENCES clients(id) ON DELETE RESTRICT,
  name text NOT NULL,
  phone text NOT NULL,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT hazmat_contacts_name_chk CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- Same shape the automation action's zod schema accepts, so a contact can
  -- never be saved that the rule it feeds would then reject.
  CONSTRAINT hazmat_contacts_phone_chk CHECK (
    length(btrim(phone)) BETWEEN 7 AND 30
    AND btrim(phone) ~ '^[+()\-0-9\s.]+$'
  )
);

CREATE INDEX IF NOT EXISTS hazmat_contacts_scope_idx
  ON hazmat_contacts (client_id, archived_at);

-- coalesce so two shared contacts (both NULL client_id) actually collide;
-- NULLs never equal each other, so without it the shared list would happily
-- accumulate duplicates. Partial on archived_at so a name can be reused after
-- the old contact is retired.
CREATE UNIQUE INDEX IF NOT EXISTS hazmat_contacts_unique_live
  ON hazmat_contacts (coalesce(client_id, 0), lower(name), phone)
  WHERE archived_at IS NULL;
