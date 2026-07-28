import { sql, type SQL } from 'drizzle-orm';

/**
 * Canonical "has this rule ever taken effect?" predicate.
 *
 * Deleting an automation is refused when it would erase evidence of what the
 * rule did to real orders. Being *published* is not that evidence -- a rule
 * published during testing that never matched an order did nothing, and
 * treating publication as history stranded those rules in the list forever.
 *
 * The subtle part is which column records a match. automation_runs.rule_id is
 * written as NULL unconditionally by the engine (see postgres-store begin(),
 * which hardcodes `ruleId: null`); the column that actually records which
 * versions fired is matched_rule_version_ids, filled in by finish(). A guard
 * that checks only rule_id is always false and therefore lets a rule that
 * really ran be deleted. The rule_id branch is kept anyway, cheap and
 * defensive, in case that column is ever populated.
 *
 * This must stay in lockstep with the automation_rule_version_immutable and
 * automation_rule_version_child_immutable database triggers, which enforce the
 * same condition one level down. This expression decides what the API offers
 * and reports; the triggers are the thing that cannot be bypassed.
 *
 * Backed by automation_runs_matched_versions_gin -- automation_runs is the
 * highest-volume table in the automations schema and this runs on every rules
 * list read.
 */
export function ruleExecutionHistoryExists(ruleId: SQL | number): SQL<boolean> {
  return sql<boolean>`(
    exists (
      select 1 from automation_runs r
      where r.matched_rule_version_ids && (
        select coalesce(array_agg(v.id), '{}'::integer[])
        from automation_rule_versions v where v.rule_id = ${ruleId}
      )
    )
    or exists (select 1 from automation_runs r where r.rule_id = ${ruleId})
    or exists (
      select 1 from automation_action_results ar
      join automation_rule_versions v on v.id = ar.rule_version_id
      where v.rule_id = ${ruleId}
    )
    or exists (select 1 from automation_reprocess_jobs j where j.rule_id = ${ruleId})
  )`;
}
