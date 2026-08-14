-- Closes the 16 WARN-level `function_search_path_mutable` Supabase advisor
-- findings. Metadata-only: no function body is rewritten, so every guard's
-- behavior is byte-for-byte unchanged.
--
-- Why `public, pg_temp` and not `''` for the public guards:
-- these functions reference unqualified public tables (billing_line_items,
-- billing_finalization_group_locks, automation_runs, automation_outbox, ...)
-- and their own sibling functions, so `public` must stay on the path. Pinning
-- `pg_temp` explicitly last removes the shadowing hole -- Postgres searches the
-- session temp schema FIRST for relation names when pg_temp is not listed. All
-- 16 are SECURITY INVOKER, and neither anon nor authenticated holds CREATE on
-- public, so nothing untrusted can be planted there either way.
--
-- Applied to production on 2026-08-15 as supabase migration
-- `pin_function_search_path`. Re-running is safe.

alter function public.audit_log_block_mutations()                             set search_path = public, pg_temp;
alter function public.billing_finalizations_block_overlap()                   set search_path = public, pg_temp;
alter function public.billing_credit_notes_block_excess()                     set search_path = public, pg_temp;
alter function public.billing_credit_notes_require_projection()               set search_path = public, pg_temp;
alter function public.billing_line_items_block_finalized_mutation()           set search_path = public, pg_temp;
alter function public.billing_line_items_block_finalized_truncate()           set search_path = public, pg_temp;
alter function public.billing_line_items_block_mixed_finalization_statement() set search_path = public, pg_temp;
alter function public.billing_line_item_lock_group(text)                      set search_path = public, pg_temp;
alter function public.billing_line_item_group_key(integer, integer, timestamptz, text)                   set search_path = public, pg_temp;
alter function public.billing_line_item_group_is_finalized(integer, integer, integer, timestamptz, text) set search_path = public, pg_temp;
alter function public.automation_rule_version_immutable()                     set search_path = public, pg_temp;
alter function public.automation_rule_version_child_immutable()               set search_path = public, pg_temp;
alter function public.enqueue_automation_order_fact_event()                   set search_path = public, pg_temp;

-- Reads a GUC only, touches no relation -- the empty path is safe and strictest.
alter function public.test_data_purge_enabled() set search_path = '';

-- pg-boss ships these fully schema-qualified (every reference is pgboss.*), so
-- the empty path is safe; pg_catalog is still searched implicitly, which is
-- what sha224/encode/format/varchar resolve against. NOTE: pg-boss recreates
-- these during its own schema migrations, which will drop the pinned
-- search_path and re-raise the advisor warning on the next pg-boss upgrade.
alter function pgboss.create_queue(text, json) set search_path = '';
alter function pgboss.delete_queue(text)       set search_path = '';
