-- PS-466: record WHY a version published, so low-risk rules can publish without
-- a simulation without the audit trail having to lie about it.
--
-- automation_versions_publish_evidence_chk required every published version to
-- carry simulation_hash = document_hash. That is the right guarantee for a rule
-- that can spend money, block a shipment, or invalidate rate proof. It is also
-- why a tag-only rule could not publish in one step: the only way to satisfy the
-- constraint without simulating would be to write the document hash into
-- simulation_hash, which forges evidence of a test that never ran.
--
-- publish_gate makes the distinction explicit and checkable:
--   'simulated'        -> proof required and present, hash must match the document
--   'low_risk_exempt'  -> no simulation was required; recorded as such, not faked
--   NULL               -> published before this migration existed
--
-- Existing rows are deliberately NOT backfilled. Published versions are
-- immutable (automation_rule_version_immutable), and that guarantee is worth
-- more than a tidy column. The constraint instead treats NULL exactly as the
-- old rule did -- proof required and matching -- which is what those rows
-- already satisfy, since nothing else could ever have been written.
--
-- The guarantee is unchanged for anything gated. What changes is that
-- "published without proof" is now a stated, queryable fact rather than an
-- impossible one. Which actions qualify is owned by
-- src/services/automations/publish-gate.ts.

ALTER TABLE automation_rule_versions
  ADD COLUMN IF NOT EXISTS publish_gate text;

ALTER TABLE automation_rule_versions
  DROP CONSTRAINT IF EXISTS automation_versions_publish_gate_chk;

ALTER TABLE automation_rule_versions
  ADD CONSTRAINT automation_versions_publish_gate_chk
  CHECK (publish_gate IS NULL OR publish_gate IN ('simulated', 'low_risk_exempt'));

ALTER TABLE automation_rule_versions
  DROP CONSTRAINT IF EXISTS automation_versions_publish_evidence_chk;

ALTER TABLE automation_rule_versions
  ADD CONSTRAINT automation_versions_publish_evidence_chk
  CHECK (
    lifecycle <> 'published'
    OR (
      published_at IS NOT NULL
      AND published_by IS NOT NULL
      AND (
        -- NULL is legacy and is held to the original rule.
        (
          COALESCE(publish_gate, 'simulated') = 'simulated'
          AND simulation_hash IS NOT NULL
          AND simulation_hash = document_hash
        )
        OR publish_gate = 'low_risk_exempt'
      )
    )
  );
