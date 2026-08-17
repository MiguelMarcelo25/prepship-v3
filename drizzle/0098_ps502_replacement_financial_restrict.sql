-- PS-502 — replacement financial attribution becomes ON DELETE RESTRICT.
--
-- HERMES RULING C, at 07f8a9bb. 0097 shipped SET NULL because the frozen card specified it,
-- and the Drizzle mapping mirrored the deployed database rather than diverging from it. The
-- ruling reverses the contract, for the reason PS-488 recovery already established on
-- `return_id` in 0092:
--
--   a billing line and a credit note are FINANCIAL HISTORY. Deleting the subject must not
--   silently null its attribution. SET NULL turns durable evidence into "not yet attributed",
--   which is factually wrong — the row was attributed, and the attribution was destroyed.
--
-- Safe to apply now precisely because no replacement exists yet: no row carries a
-- replacement_id, so nothing can violate the stricter constraint and validation is immediate.
-- After a real replacement carries billing, this would be a forward-only change.
--
-- Re-runnable: the FK is located by what it references rather than by an assumed name, then
-- dropped and re-added, so a second run converges on the same state.

do $$
declare
  fk_name text;
begin
  -- billing_line_items -> replacements
  select conname into fk_name
  from pg_constraint
  where conrelid = 'billing_line_items'::regclass
    and contype = 'f'
    and confrelid = 'replacements'::regclass
  limit 1;

  if fk_name is not null then
    execute format('alter table billing_line_items drop constraint %I', fk_name);
  end if;

  alter table billing_line_items
    add constraint billing_line_items_replacement_id_fkey
    foreign key (replacement_id) references replacements(id) on delete restrict;

  -- billing_credit_notes -> replacements
  select conname into fk_name
  from pg_constraint
  where conrelid = 'billing_credit_notes'::regclass
    and contype = 'f'
    and confrelid = 'replacements'::regclass
  limit 1;

  if fk_name is not null then
    execute format('alter table billing_credit_notes drop constraint %I', fk_name);
  end if;

  alter table billing_credit_notes
    add constraint billing_credit_notes_replacement_id_fkey
    foreign key (replacement_id) references replacements(id) on delete restrict;
end $$;

-- ── Activity detail ──────────────────────────────────────────────────────────
--
-- Hermes finding 2: decision 7 requires a written reason for a billability change AND an
-- activity event, but replacement_activity_events had nowhere to preserve the reason — so the
-- command validated it and then discarded it, which is worse than not asking for it. Follows
-- the return_activity_events precedent, which carries `detail` for exactly this.
alter table replacement_activity_events
  add column if not exists detail text;

comment on column replacement_activity_events.detail is
  'PS-502: the written reason behind an event (billability change, override, remap). Required by decision 7.';
comment on column billing_line_items.replacement_id is
  'PS-502: relational replacement attribution. RESTRICT (0098, Hermes ruling C) — a billing line is financial history and its attribution must not be silently nulled.';
comment on column billing_credit_notes.replacement_id is
  'PS-502: which replacement a finalized credit belongs to. RESTRICT (0098, Hermes ruling C).';
