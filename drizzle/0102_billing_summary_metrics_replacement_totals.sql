-- PS-502 AC-18 — give replacement money buckets in the cached billing summary.
--
-- THE HOLE THIS CLOSES
--
-- The same hole 0095 closed for returns, one vocabulary over. billing_summary_metrics
-- caches a client's billing summary as per-category columns plus grand_total. grand_total
-- is `sum(<amount>)` over EVERY line type, while the category columns are filtered sums
-- over specific ones. No column covers replacement money (replace_postage /
-- replace_pick_pack), so the moment a re-ship is billed the cached categories sum to LESS
-- than the cached grand_total and the difference belongs to nothing the operator can see.
--
-- Unlike 0095 this is NOT latent behind a flag. RETURN_BILLING_ENABLED kept return lines
-- out of the table until someone chose to flip it; replacement lines are written by the
-- shipped command directly, so the FIRST billed re-ship opens the hole.
--
-- WHY TWO MONEY COLUMNS AND NOT ONE
--
-- Postage and pick/pack stay apart for the same reason they are two line types: a re-ship's
-- carrier cost and its handling charge get answered separately when a client asks who paid
-- for the mistake. A single replacement_total would fold that distinction away, and the
-- cache is the one place the split would then be unrecoverable from.
--
-- WHY replacement_count EXISTS WHEN order_count ALREADY DOES
--
-- A replacement line carries the ORIGINAL order's id, so order_count — count(distinct
-- order_id) — structurally cannot see one. Two re-ships of one order are one order and two
-- replacements. Without its own column the volume behind the money is invisible, and an
-- operator reading a non-zero replacement bucket against an unchanged order count would
-- reasonably conclude the money was a duplicate.
--
-- NOT NULL with a default rather than nullable, same as 0095: a null here would push
-- "unknown" into a money read model and leave every consumer to invent its own reading of
-- it. `default 0` is the TRUE value for every row that exists right now — no replacement
-- money has ever been aggregated into this cache — not a convenient placeholder.
--
-- Safe to re-run. Additive; no existing column changes type or meaning, and the cache's own
-- freshness check recomputes any row whose period is stale, so no manual backfill is
-- required beyond the default.

alter table billing_summary_metrics
  add column if not exists replace_postage_total numeric(14, 2) not null default 0;

alter table billing_summary_metrics
  add column if not exists replace_pick_pack_total numeric(14, 2) not null default 0;

alter table billing_summary_metrics
  add column if not exists replacement_count integer not null default 0;

comment on column billing_summary_metrics.replace_postage_total is
  'PS-502: re-ship postage for the period. Category columns plus this must reconcile to grand_total.';
comment on column billing_summary_metrics.replace_pick_pack_total is
  'PS-502: re-ship handling for the period. Category columns plus this must reconcile to grand_total.';
comment on column billing_summary_metrics.replacement_count is
  'PS-502: distinct replacements billed in the period. NOT orders — a replacement line carries the original order id.';
