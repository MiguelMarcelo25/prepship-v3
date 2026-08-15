-- PS-501 AC-4 — give return money a bucket in the cached billing summary.
--
-- THE HOLE THIS CLOSES
--
-- billing_summary_metrics caches a client's billing summary as per-category columns plus
-- grand_total. grand_total is `sum(<amount>)` over EVERY line type, while the category
-- columns are filtered sums over six specific ones. No column covers return money
-- (return_postage / return_processing_fee, plus the frozen legacy return_label /
-- return_processing / return spellings), so the moment a return line exists the cached
-- categories sum to LESS than the cached grand_total and the difference belongs to
-- nothing the operator can see.
--
-- Latent today rather than live: RETURN_BILLING_ENABLED is false, so no return lines are
-- generated and every existing cache row genuinely has zero return money. That is exactly
-- why `default 0` is correct for the backfill — it is the true value for every row that
-- exists right now, not a convenient placeholder. It would have stopped being true on the
-- day the flag was switched on, which is the worst possible moment to discover the gap.
--
-- NOT NULL with a default rather than nullable: a null here would push "unknown" into a
-- money read model, and every consumer would then need its own opinion about what null
-- means — which is the class of ambiguity PS-501 exists to remove.
--
-- Safe to re-run. Additive; no existing column changes type or meaning, and the cache's
-- own freshness check recomputes any row whose period is stale, so no manual backfill is
-- required beyond the default.

alter table billing_summary_metrics
  add column if not exists return_total numeric(14, 2) not null default 0;

comment on column billing_summary_metrics.return_total is
  'PS-501: return money for the period. Category columns plus this must reconcile to grand_total.';
