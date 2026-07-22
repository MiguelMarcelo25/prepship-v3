-- PS-432 production classification. Run only in a READ ONLY transaction.
-- Returns aggregate evidence only: no customer, tracking, label URL, or secret data.
WITH pending AS (
  SELECT i.*
  FROM print_queue_batch_job_items i
  WHERE i.state IN ('provider_pending', 'provider_pending_recovery')
), evidence AS (
  SELECT
    p.id,
    p.job_id,
    p.order_id,
    p.client_id,
    p.state,
    EXISTS (
      SELECT 1
      FROM shipments s
      WHERE s.order_id = p.order_id
        AND s.voided = false
        AND s.is_return = false
        AND s.label_url IS NOT NULL
        AND coalesce(s.label_tracking, s.tracking_number) IS NOT NULL
        AND (s.label_shipment_id IS NOT NULL OR s.label_provider_key IS NOT NULL)
    ) AS has_durable_provider_receipt,
    EXISTS (
      SELECT 1
      FROM print_queue_orders q
      WHERE q.order_id = p.order_id::text
        AND q.client_id = p.client_id
    ) AS has_queue_entry,
    EXISTS (
      SELECT 1
      FROM label_purchase_intents lpi
      WHERE lpi.order_id = p.order_id
        AND lpi.state IN ('provider_pending', 'reconcile_required')
    ) AS has_unresolved_purchase_intent,
    EXISTS (
      SELECT 1
      FROM external_operations operation
      WHERE operation.subject_type = 'order'
        AND operation.subject_id = p.order_id::text
        AND operation.kind IN ('forward_label', 'shopify_label')
        AND operation.state IN ('in_flight', 'reconcile_required', 'receipt_recorded')
    ) AS has_unresolved_external_operation,
    EXISTS (
      SELECT 1
      FROM external_operations operation
      WHERE operation.subject_type = 'order'
        AND operation.subject_id = p.order_id::text
        AND operation.kind IN ('forward_label', 'shopify_label')
        AND operation.state = 'receipt_recorded'
    ) AS has_unconsumed_provider_receipt
  FROM pending p
)
SELECT
  count(*)::int AS item_count,
  count(DISTINCT job_id)::int AS job_count,
  count(DISTINCT order_id)::int AS order_count,
  count(*) FILTER (WHERE state = 'provider_pending')::int AS provider_pending_count,
  count(*) FILTER (WHERE state = 'provider_pending_recovery')::int
    AS provider_pending_recovery_count,
  count(*) FILTER (WHERE has_durable_provider_receipt)::int AS durable_provider_receipt_count,
  count(*) FILTER (WHERE has_queue_entry)::int AS queue_entry_count,
  count(*) FILTER (WHERE has_unresolved_purchase_intent)::int
    AS unresolved_purchase_intent_count,
  count(*) FILTER (WHERE has_unresolved_external_operation)::int
    AS unresolved_external_operation_count,
  count(*) FILTER (WHERE has_unconsumed_provider_receipt)::int
    AS unconsumed_provider_receipt_count
FROM evidence;
