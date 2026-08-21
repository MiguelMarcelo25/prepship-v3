-- PS-502 AC-13 — durable, replacement-scoped financial actions.
--
-- Per user override `unlock shipped data` on 2026-08-19: this migration adds only
-- append-only/retry state for replacement financial decisions. It does not change a
-- replacement lifecycle status, issue a provider void, buy postage, or enable either
-- replacement feature flag.
--
-- A shipped replacement cannot be lifecycle-cancelled. Its financial reversal is a
-- separate action whose request must survive a process death between removing editable
-- rows and posting replacement-attributed credits. Pre-ship cancellation also records a
-- completed cleanup fact; the repair worker uses the same table for historical stranded
-- editable rows left by the former post-commit route flow.

create table if not exists replacement_financial_actions (
  id bigint generated always as identity primary key,
  replacement_id integer not null references replacements(id) on delete restrict,
  client_id integer not null references clients(id) on delete restrict,
  action_type text not null,
  reason text not null,
  idempotency_key text not null,
  requested_by_type text not null,
  requested_by_email text,
  status text not null default 'pending',
  attempts integer not null default 0,
  editable_removed integer not null default 0,
  credits_settled integer not null default 0,
  credited_amount numeric(12, 2) not null default 0,
  last_error text,
  next_run_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint replacement_financial_actions_type_check
    check (action_type in ('pre_ship_cancellation_cleanup', 'post_ship_financial_reversal')),
  constraint replacement_financial_actions_status_check
    check (status in ('pending', 'processing', 'retry', 'completed', 'review_required')),
  constraint replacement_financial_actions_reason_check
    check (length(btrim(reason)) > 0),
  constraint replacement_financial_actions_idempotency_check
    check (length(btrim(idempotency_key)) > 0),
  constraint replacement_financial_actions_attempts_check
    check (attempts >= 0),
  constraint replacement_financial_actions_results_check
    check (editable_removed >= 0 and credits_settled >= 0 and credited_amount >= 0),
  constraint replacement_financial_actions_completion_check
    check ((status = 'completed') = (completed_at is not null))
);

create unique index if not exists replacement_financial_actions_idempotency_unq
  on replacement_financial_actions (idempotency_key);

create index if not exists replacement_financial_actions_replacement_idx
  on replacement_financial_actions (replacement_id, created_at);

create index if not exists replacement_financial_actions_client_idx
  on replacement_financial_actions (client_id, created_at);

create index if not exists replacement_financial_actions_due_idx
  on replacement_financial_actions (next_run_at, id)
  where status in ('pending', 'retry', 'processing');

-- Every PS-502 relation is in public. Supabase/PostgREST may expose public relations through
-- grants/default privileges, so RLS-with-no-policies is the database backstop even though the
-- API never exposes these tables directly. Server-side Postgres connections remain the only
-- writer. Keeping the hardening in the final lane also repairs an installation where 0096-
-- 0101 were staged before this audit.
alter table replacements enable row level security;
alter table replacement_items enable row level security;
alter table replacement_activity_events enable row level security;
alter table replacement_label_purchase_intents enable row level security;
alter table replacement_item_remaps enable row level security;
alter table replacement_original_order_holds enable row level security;
alter table replacement_financial_actions enable row level security;

comment on table replacement_financial_actions is
  'PS-502: durable replacement-scoped cancellation cleanup and post-ship financial reversal obligations.';
comment on column replacement_financial_actions.idempotency_key is
  'Stable decision identity. Replays with a different replacement/action/reason are rejected by the service.';
comment on column replacement_financial_actions.status is
  'pending/processing/retry are worker-owned; completed is final; review_required needs a human decision.';
