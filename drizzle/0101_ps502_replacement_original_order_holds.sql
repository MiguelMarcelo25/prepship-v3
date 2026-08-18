-- PS-502 AC-16 — what happens to a replacement when the ORIGINAL order is cancelled.
--
-- HERMES work item 11. One additive table; nothing existing changes shape and no historical
-- row is rewritten.
--
-- ── WHY A TABLE AND NOT A STATUS ────────────────────────────────────────────────────────
--
-- The tempting shape is a tenth replacement status. It is wrong twice over.
--
--   * `replacements_status_check` and `ALLOWED_TRANSITIONS` are a closed diagram, and
--     `shipped -> ['completed']` is the whole of a shipped replacement's future. A status
--     meaning "the original went away" would have to be reachable from `shipped`, which
--     would make a delivered re-ship cancellable — the one thing the card forbids.
--   * A status records WHERE a replacement is. AC-16 needs to record WHY, WHAT PROVED IT,
--     and WHAT A HUMAN STILL OWES AN ANSWER TO. That is a row, not an enum member.
--
-- ── WHY THE EVIDENCE POINTER IS A COLUMN ────────────────────────────────────────────────
--
-- A hold exists because a receipt exists: a row in `order_lifecycle_events`, a row in
-- `webhook_events`, or a named operator who declared it. `reason` is human prose and is
-- NEVER read by code — inferring a cancellation from prose is the mistake PS-488 rejected
-- and the drift path already refuses to repeat.
--
-- Both evidence tables are append-only and mutation-blocked by trigger, so ON DELETE RESTRICT
-- costs nothing and a hold can never end up pointing at a receipt that vanished.
--
-- ── WHY `order_refunded` EXISTS WITH NO PRODUCER ────────────────────────────────────────
--
-- AC-16 says "cancelled/refunded". There is no refund concept anywhere in this repo: not in
-- `OrderLifecycleStatus`, not in `NormalizedOrderStatus`, not as a column. The only
-- `financial_status = 'refunded'` read resolves a $0 import total and means nothing here.
--
-- So the vocabulary admits it and the code does not pretend to detect it. `order_refunded`
-- can only ever arrive by operator declaration, and the surface for that is item 13. Saying
-- "refunds are operator-declared" is honest; silently mapping refund onto cancelled is not.

CREATE TABLE IF NOT EXISTS replacement_original_order_holds (
  id serial PRIMARY KEY,
  replacement_id integer NOT NULL REFERENCES replacements(id) ON DELETE RESTRICT,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,

  trigger_kind text NOT NULL,
  evidence_kind text NOT NULL,
  order_lifecycle_event_id integer REFERENCES order_lifecycle_events(id) ON DELETE RESTRICT,
  webhook_event_id integer REFERENCES webhook_events(id) ON DELETE RESTRICT,
  declared_by text,

  -- Human prose. Never parsed, never matched on, never used to decide anything.
  reason text NOT NULL,

  phase text NOT NULL,
  disposition text NOT NULL,
  -- Null unless a human still owes an answer. A money question the code refuses to answer
  -- is recorded here rather than resolved by a default.
  open_question text,

  -- What the replacement was when the hold was raised, so a later reader can tell whether
  -- the hold acted on the state it believed it was acting on.
  status_at_hold text NOT NULL,
  state_version_at_hold integer NOT NULL,

  resolved_at timestamptz,
  resolved_by text,
  resolution text,

  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT replacement_holds_trigger_kind_check
    CHECK (trigger_kind IN ('order_cancelled', 'order_refunded')),

  CONSTRAINT replacement_holds_evidence_kind_check
    CHECK (evidence_kind IN ('order_lifecycle_event', 'webhook_event', 'operator_declaration')),

  CONSTRAINT replacement_holds_phase_check
    CHECK (phase IN (
      'pre_dispatch', 'pre_dispatch_label_at_risk', 'post_dispatch', 'terminal_no_action'
    )),

  CONSTRAINT replacement_holds_disposition_check
    CHECK (disposition IN ('cancelled', 'review', 'flagged_post_dispatch', 'no_action')),

  -- Exactly one evidence pointer, and it must be the one its kind names. Shaped after
  -- billing_line_items_adjustment_reference_chk: a kind without its pointer is an
  -- unfalsifiable claim.
  CONSTRAINT replacement_holds_evidence_pointer_check
    CHECK (
      (evidence_kind = 'order_lifecycle_event'
        AND order_lifecycle_event_id IS NOT NULL
        AND webhook_event_id IS NULL
        AND declared_by IS NULL)
      OR (evidence_kind = 'webhook_event'
        AND webhook_event_id IS NOT NULL
        AND order_lifecycle_event_id IS NULL
        AND declared_by IS NULL)
      OR (evidence_kind = 'operator_declaration'
        AND declared_by IS NOT NULL
        AND order_lifecycle_event_id IS NULL
        AND webhook_event_id IS NULL)
    ),

  -- A resolution is a decision and carries its author.
  CONSTRAINT replacement_holds_resolution_check
    CHECK (resolved_at IS NULL OR (resolved_by IS NOT NULL AND resolution IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS replacement_original_order_holds_idempotency_unq
  ON replacement_original_order_holds (idempotency_key);

-- At most ONE open hold per replacement. A second cancellation signal for the same
-- replacement must collide rather than stack a second unresolved question on it.
CREATE UNIQUE INDEX IF NOT EXISTS replacement_original_order_holds_open_unq
  ON replacement_original_order_holds (replacement_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS replacement_original_order_holds_order_idx
  ON replacement_original_order_holds (order_id, created_at);

-- The operator queue: everything still awaiting a human, newest first.
CREATE INDEX IF NOT EXISTS replacement_original_order_holds_open_queue_idx
  ON replacement_original_order_holds (created_at DESC)
  WHERE resolved_at IS NULL;
