-- PS-502 — relational replacement identity on billing rows and credit notes.
--
-- ADDITIVE ONLY: two nullable columns, one partial unique index, one CHECK, one index.
-- No existing column changes type or meaning and no row is rewritten. This is inside the
-- card's "no unlock" list; the writers that create these rows are not in this slice.
--
-- RENUMBERED from the card's 0093 — see the header of 0096 for why.
--
-- Safe to re-run: every object is guarded.

-- ── Billing line identity ────────────────────────────────────────────────────
--
-- Follows PS-488 M1's relational `return_id` precedent (0089) rather than encoding
-- identity in text. NULL means "not yet attributed", NOT "not a replacement line" — the
-- same reading return_id carries.
alter table billing_line_items
  add column if not exists replacement_id integer references replacements(id) on delete set null;

-- At most one postage row and one pick/pack row per replacement.
--
-- Required because billing_li_shipment_unique_idx keys on
-- (order_id, shipment_id, line_type, description) — so a DESCRIPTION REWORD during
-- regeneration would otherwise mint a second charge for the same work. Keep `description`
-- presentation-only; identity lives here.
create unique index if not exists billing_li_replacement_line_unq
  on billing_line_items(replacement_id, line_type)
  where replacement_id is not null
    and line_type in ('replace_postage', 'replace_pick_pack');

-- A replacement line without its shipment or its replacement is unattributable money.
-- NOT VALID then VALIDATE: the scan takes a weaker lock, and no existing row can violate
-- it (no row carries these line types yet), so validation is immediate.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'billing_li_replacement_identity_check'
  ) then
    alter table billing_line_items
      add constraint billing_li_replacement_identity_check
      check (
        line_type not in ('replace_postage', 'replace_pick_pack')
        or (shipment_id is not null and replacement_id is not null)
      ) not valid;
    alter table billing_line_items validate constraint billing_li_replacement_identity_check;
  end if;
end $$;

-- ── Finalized credit attribution ─────────────────────────────────────────────
--
-- Without this, cancelling ONE of two replacements on an order cannot be attributed:
-- reconcileFinalizedBillingBillingOrderAdjustments is order-grained
-- (BillingRegenerationCandidate = { orderId, currentTotal }), so original $20 +
-- replacement A $8 + replacement B $10 collapses into one order-level number and the
-- credit for A alone has nowhere to point.
--
-- A deterministic idempotency key is NOT a substitute for this column: parsing identity
-- out of a `reason` string is exactly the mistake PS-488 rejected.
alter table billing_credit_notes
  add column if not exists replacement_id integer references replacements(id) on delete set null;

create index if not exists billing_credit_notes_replacement_idx
  on billing_credit_notes(finalization_id, replacement_id, created_at)
  where replacement_id is not null;

comment on column billing_line_items.replacement_id is
  'PS-502: relational replacement attribution. NULL = not yet attributed, not "not a replacement line".';
comment on column billing_credit_notes.replacement_id is
  'PS-502: which replacement a finalized credit belongs to. Required to credit one of several on an order.';
