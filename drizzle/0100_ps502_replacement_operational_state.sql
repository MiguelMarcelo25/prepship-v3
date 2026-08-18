-- PS-502 — the operational persistence label purchase, remap and recovery need.
--
-- HERMES work item 2. Two new tables, both additive; nothing existing changes shape and no
-- historical row is rewritten.
--
-- ── WHY A SEPARATE PURCHASE-INTENT TABLE ────────────────────────────────────────────────
--
-- The obvious move is to add `replacement_id` to `label_purchase_intents`. It is wrong, and
-- the reason is in that table's authority rather than its columns.
--
--   * `label_purchase_intents.order_id` is NOT NULL and its unresolved index is keyed on
--     `(order_id) WHERE state IN ('provider_pending','reconcile_required')`.
--   * `assertNoUnresolvedLabelPurchaseIntent(orderId)` FAILS CLOSED on that key, and first
--     PROMOTES every `provider_pending` row for the order to `reconcile_required`.
--
-- A replacement intent carries `order_id = originalOrder.id`, so sharing that table would
-- mean:
--
--   * a stuck replacement purchase blocks the ORIGINAL order's label flow;
--   * an unresolved intent on the original blocks the REPLACEMENT's purchase;
--   * merely checking the original order MUTATES replacement state from a code path that
--     knows nothing about replacements.
--
-- One authority, two subjects. The replacement gets its own table, its own unresolved index
-- and its own reconciliation, exactly as it already has its own reference, shipment,
-- lifecycle and billing identity.
--
-- ── WHY REMAPS ARE THEIR OWN TABLE ──────────────────────────────────────────────────────
--
-- The card is explicit that frozen requested facts stay frozen: an approved remap must not
-- rewrite the original snapshot in `replacement_items`, because that snapshot is what was
-- REQUESTED and an audit needs it after the resolution. Remaps are therefore append-only
-- rows recording previous target, resolved target, who decided and why. The effective target
-- is the latest remap for an item, falling back to the frozen coordinate when there is none.
--
-- Safe to re-run: every object is guarded.

-- ── Replacement-scoped label purchase intents ───────────────────────────────────────────
create table if not exists replacement_label_purchase_intents (
  id serial primary key,

  -- RESTRICT: an intent is evidence that money may have moved at a provider. Deleting its
  -- subject must not erase it.
  replacement_id integer not null references replacements(id) on delete restrict,
  replacement_shipment_id integer references shipments(id) on delete set null,

  provider text not null,

  -- The deterministic identity sent to the provider. Replacement-scoped by construction and
  -- UNIQUE here, so a retry cannot mint a second purchase under a new identity.
  provider_idempotency_key text not null,

  -- Fingerprint of the FROZEN resolved request (address, service, package, dims, weight).
  -- A retry must reuse the same frozen request; mutable order or rate data changing
  -- underneath must not silently change what is bought.
  request_fingerprint text not null,

  -- Incremented only by an explicit, audited new attempt — never by an ordinary retry.
  purchase_attempt integer not null default 1,

  state text not null default 'provider_pending',

  -- Provider receipt identity. Stable ids, NOT the tracking number: a tracking number is not
  -- a purchase identity and cannot prove which attempt produced it.
  provider_transaction_id text,
  provider_label_id text,
  provider_shipment_id text,

  -- The resolved request as dispatched, for reconciliation and audit.
  resolved_request jsonb,

  last_error text,
  -- Classified, so "the provider refused" is distinguishable from "we never heard back".
  last_error_class text,
  reconciliation_state text,
  reconciled_at timestamptz,

  -- Void is a separate explicitly authorized command; this records its outcome.
  void_state text,
  provider_void_id text,
  voided_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,

  constraint replacement_label_purchase_intents_state_check check (state in (
    'provider_pending', 'purchased', 'failed_pre_purchase', 'reconcile_required', 'voided'
  )),

  -- A purchased intent must carry provable provider identity. Without this, "purchased" is a
  -- claim with nothing behind it, and a retry cannot tell it apart from an unknown outcome.
  constraint replacement_label_purchase_intents_receipt_check check (
    state <> 'purchased'
    or (provider_transaction_id is not null or provider_label_id is not null)
  )
);

create unique index if not exists replacement_label_purchase_intents_key_unq
  on replacement_label_purchase_intents (provider_idempotency_key);

-- At most one UNRESOLVED intent per replacement — the replacement-scoped analogue of
-- label_purchase_intents_unresolved_idx, and deliberately NOT keyed on order_id.
create unique index if not exists replacement_label_purchase_intents_active_unq
  on replacement_label_purchase_intents (replacement_id)
  where state in ('provider_pending', 'reconcile_required');

create index if not exists replacement_label_purchase_intents_replacement_idx
  on replacement_label_purchase_intents (replacement_id, created_at);

-- ── Append-only remap resolutions ───────────────────────────────────────────────────────
create table if not exists replacement_item_remaps (
  id serial primary key,

  replacement_id integer not null references replacements(id) on delete restrict,
  -- RESTRICT rather than CASCADE: a remap is audited evidence of a decision, and removing the
  -- item it resolved must not delete the record that it was resolved.
  replacement_item_id integer not null references replacement_items(id) on delete restrict,

  -- What was frozen BEFORE this resolution. Kept here so replacement_items is never rewritten
  -- and the originally requested coordinate survives the remap.
  previous_order_line_index integer not null,
  previous_source_line_fingerprint text not null,

  -- What it resolves to. Equal to the previous values when the resolution is 'retained'.
  resolved_order_line_index integer not null,
  resolved_source_line_fingerprint text not null,

  resolution text not null,
  -- Monotonic per item, so the effective target is unambiguous when several remaps exist.
  remap_version integer not null default 1,

  actor_type text not null,
  actor_email text,
  -- Required: a remap without a written reason is an unattributable retarget, which is the
  -- exact failure section A exists to prevent.
  reason text not null,

  idempotency_key text not null,
  created_at timestamptz not null default now(),

  constraint replacement_item_remaps_resolution_check check (
    resolution in ('remapped', 'retained', 'rejected')
  ),
  constraint replacement_item_remaps_version_positive_check check (remap_version > 0)
);

create unique index if not exists replacement_item_remaps_idempotency_unq
  on replacement_item_remaps (idempotency_key);

create unique index if not exists replacement_item_remaps_item_version_unq
  on replacement_item_remaps (replacement_item_id, remap_version);

create index if not exists replacement_item_remaps_replacement_idx
  on replacement_item_remaps (replacement_id, created_at);

comment on table replacement_label_purchase_intents is
  'PS-502: replacement-scoped label purchase intents. Deliberately separate from label_purchase_intents, whose unresolved authority is keyed on order_id.';
comment on column replacement_label_purchase_intents.provider_idempotency_key is
  'PS-502: deterministic replacement-scoped provider identity. Never the original order key.';
comment on table replacement_item_remaps is
  'PS-502: append-only remap resolutions. replacement_items keeps the originally REQUESTED snapshot; the effective target is the latest remap.';
