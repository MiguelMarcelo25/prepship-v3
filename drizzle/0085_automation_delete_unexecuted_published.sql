-- PS-466: let an operator delete a published rule that never took effect.
--
-- Publishing a rule made it permanent. The immutability triggers rejected any
-- DELETE of a published version, and automation_rule_versions.rule_id is
-- ON DELETE RESTRICT, so the rule row could not go either. "Archived" was the
-- terminal state for anything ever published -- including a rule published for
-- five minutes during testing that never matched a single order.
--
-- The property worth protecting is the audit trail: you must never be able to
-- rewrite or erase what an automation actually did to an order. A published
-- version with no runs, no action results, and no reprocess jobs did nothing,
-- so there is no trail to protect.
--
-- What changes: DELETE of a published version is permitted only when nothing
-- references it. What does NOT change: UPDATE of a published version stays
-- unconditionally forbidden, so published content can still never be rewritten,
-- and the moment a rule fires it becomes permanent.
--
-- Which column proves a match is the subtle part. automation_runs.rule_id is
-- written as NULL unconditionally by the engine (postgres-store begin()
-- hardcodes `ruleId: null`); the column that actually records which versions
-- fired is matched_rule_version_ids, filled in by finish(). A guard checking
-- only rule_id is always false and would let a rule that really ran be deleted.
-- Both are checked: matched_rule_version_ids is the real signal, rule_id is
-- kept as a cheap defensive branch in case it is ever populated.
--
-- automation_runs is the highest-volume table in this schema (~230k rows and
-- growing continuously), and the array predicate also runs on every rules list
-- read, so it gets a GIN index rather than a sequential scan.
CREATE INDEX IF NOT EXISTS automation_runs_matched_versions_gin
  ON automation_runs USING gin (matched_rule_version_ids);

CREATE OR REPLACE FUNCTION public.automation_rule_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.lifecycle = 'published' THEN
    -- Content of a published version is immutable, full stop.
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'published automation rule versions are immutable';
    END IF;

    -- DELETE is allowed only for a version that never took effect.
    IF EXISTS (SELECT 1 FROM automation_runs WHERE matched_rule_version_ids && ARRAY[OLD.id])
       OR EXISTS (SELECT 1 FROM automation_runs WHERE rule_id = OLD.rule_id)
       OR EXISTS (SELECT 1 FROM automation_action_results WHERE rule_version_id = OLD.id)
       OR EXISTS (SELECT 1 FROM automation_reprocess_jobs WHERE rule_version_id = OLD.id)
    THEN
      RAISE EXCEPTION 'published automation rule versions with execution history are immutable';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- Same relaxation for conditions/actions. The service deletes children
-- explicitly before the version row, so this trigger fires while the published
-- parent still exists and would otherwise reject the delete on its own.
CREATE OR REPLACE FUNCTION public.automation_rule_version_child_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  parent_version_id integer;
  parent_lifecycle text;
  parent_rule_id integer;
BEGIN
  parent_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.rule_version_id ELSE NEW.rule_version_id END;
  SELECT lifecycle, rule_id INTO parent_lifecycle, parent_rule_id
  FROM automation_rule_versions WHERE id = parent_version_id;

  IF parent_lifecycle = 'published' THEN
    IF TG_OP <> 'DELETE' THEN
      RAISE EXCEPTION 'published automation rule version children are immutable';
    END IF;

    IF EXISTS (SELECT 1 FROM automation_runs WHERE matched_rule_version_ids && ARRAY[parent_version_id])
       OR EXISTS (SELECT 1 FROM automation_runs WHERE rule_id = parent_rule_id)
       OR EXISTS (SELECT 1 FROM automation_action_results WHERE rule_version_id = parent_version_id)
       OR EXISTS (SELECT 1 FROM automation_reprocess_jobs WHERE rule_version_id = parent_version_id)
    THEN
      RAISE EXCEPTION 'published automation rule version children with execution history are immutable';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
