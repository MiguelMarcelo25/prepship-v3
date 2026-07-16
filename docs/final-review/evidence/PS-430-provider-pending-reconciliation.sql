-- PS-430 bounded production reconciliation for the July 13 Print Queue incident.
--
-- Per user override unlock shipped data on 2026-07-16: this statement updates
-- only stale print_queue_batch_job_items sidecar metadata after proving that
-- the provider outcome is already durable in the canonical shipments table.
-- It never updates orders or shipments, calls a provider, creates/voids a label,
-- charges postage, queues a missing label, or sends a marketplace notification.
--
-- Execute only after the read-only PS-432 classification and explicit operator
-- approval. The guard is incident-specific: exactly 9 pending sidecars, 8 orders,
-- and 3 inactive jobs. Any changed or ambiguous fact makes guard_passed=false
-- and updates zero rows.
WITH all_pending AS MATERIALIZED (
  SELECT
    i.id,
    i.job_id,
    i.order_id,
    i.client_id,
    j.status AS job_status,
    j.active AS job_active
  FROM print_queue_batch_job_items i
  LEFT JOIN print_queue_send_jobs j ON j.job_id = i.job_id
  WHERE i.state IN ('provider_pending', 'provider_pending_recovery')
), candidates AS MATERIALIZED (
  SELECT
    p.*,
    receipt.active_receipt_count,
    receipt.label_url,
    receipt.tracking_number,
    queue_entry.id AS queue_entry_id,
    EXISTS (
      SELECT 1
      FROM label_purchase_intents lpi
      WHERE lpi.order_id = p.order_id
        AND lpi.state IN ('provider_pending', 'reconcile_required')
    ) AS has_unresolved_purchase_intent
  FROM all_pending p
  LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS active_receipt_count,
      max(s.label_url) AS label_url,
      max(coalesce(s.label_tracking, s.tracking_number)) AS tracking_number
    FROM shipments s
    WHERE s.order_id = p.order_id
      AND coalesce(s.voided, false) = false
      AND coalesce(s.is_return, false) = false
      AND nullif(trim(s.label_url), '') IS NOT NULL
      AND nullif(trim(coalesce(s.label_tracking, s.tracking_number)), '') IS NOT NULL
      AND (s.label_shipment_id IS NOT NULL OR nullif(trim(s.label_provider_key), '') IS NOT NULL)
  ) receipt ON true
  LEFT JOIN LATERAL (
    SELECT q.id
    FROM print_queue_orders q
    WHERE q.order_id = p.order_id::text
      AND q.client_id = p.client_id
      AND q.label_url = receipt.label_url
    ORDER BY q.created_at DESC
    LIMIT 1
  ) queue_entry ON true
), guard AS MATERIALIZED (
  SELECT
    count(*) = 9
      AND count(DISTINCT order_id) = 8
      AND count(DISTINCT job_id) = 3
      AND count(*) FILTER (
        WHERE job_active = false
          AND job_status NOT IN ('pending', 'running')
      ) = 9
      AND count(*) FILTER (WHERE active_receipt_count = 1) = 9
      AND count(*) FILTER (WHERE has_unresolved_purchase_intent) = 0
      AS ok,
    count(*)::int AS pending_count,
    count(DISTINCT order_id)::int AS order_count,
    count(DISTINCT job_id)::int AS job_count,
    count(*) FILTER (WHERE active_receipt_count = 1)::int AS durable_receipt_count,
    count(*) FILTER (WHERE queue_entry_id IS NOT NULL)::int AS matching_queue_entry_count,
    count(*) FILTER (WHERE has_unresolved_purchase_intent)::int
      AS unresolved_purchase_intent_count
  FROM candidates
), updated AS (
  UPDATE print_queue_batch_job_items item
  SET
    state = CASE
      WHEN candidate.queue_entry_id IS NOT NULL THEN 'queued'
      ELSE 'shipment_persisted'
    END,
    blocked_reason = NULL,
    error_message = NULL,
    queue_entry_id = coalesce(item.queue_entry_id, candidate.queue_entry_id),
    tracking_number = coalesce(item.tracking_number, candidate.tracking_number),
    updated_at = now()
  FROM candidates candidate
  CROSS JOIN guard
  WHERE guard.ok
    AND item.id = candidate.id
    AND item.state IN ('provider_pending', 'provider_pending_recovery')
  RETURNING item.state
)
SELECT
  guard.ok AS guard_passed,
  guard.pending_count,
  guard.order_count,
  guard.job_count,
  guard.durable_receipt_count,
  guard.matching_queue_entry_count,
  guard.unresolved_purchase_intent_count,
  count(updated.state)::int AS updated_count,
  count(*) FILTER (WHERE updated.state = 'queued')::int AS reconciled_queued_count,
  count(*) FILTER (WHERE updated.state = 'shipment_persisted')::int
    AS reconciled_shipment_persisted_count
FROM guard
LEFT JOIN updated ON true
GROUP BY
  guard.ok,
  guard.pending_count,
  guard.order_count,
  guard.job_count,
  guard.durable_receipt_count,
  guard.matching_queue_entry_count,
  guard.unresolved_purchase_intent_count;
