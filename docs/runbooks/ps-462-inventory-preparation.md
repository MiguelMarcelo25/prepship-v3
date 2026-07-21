# PS-462 phase-1 inventory preparation runbook

This runbook prepares and verifies the additive `0073` inventory-ledger schema. It does
not authorize or perform the correction movements, the `0074` cutover, a Git push, or a
Render deployment.

## Ownership and sequencing risk

- Schema authority: `drizzle/0073_inventory_quantity_sot.sql`.
- Operator adapter: `scripts/ps-462-inventory-preparation-operator.ts`; it adds no schema
  decisions and verifies the authoritative SQL.
- Imperfect-data entry point: legacy inventory-ledger writers omit `source_entity` and
  `source_id`. The `0073` insert guard intentionally rejects those writes.
- Therefore, do not apply `0073` while the old API or workers can write. Use a maintenance
  window with the compatible PS-462 runtime built and ready for immediate deployment.

The repository uses explicit late-numbered migration operators; `0073` is outside
`drizzle/meta/_journal.json`. Do not assume `drizzle-kit migrate` will discover it, and do
not apply it through an unrecorded Dashboard edit.

## Approval boundary

This prepared procedure is not production-SQL approval. Before execution, DJ must clearly
approve all three production actions: the `0073` application, the named maintenance window,
and the compatible API/worker deployment. Correction movements and `0074` require later,
separate approvals.

## Preflight — read only

1. Confirm the exact reviewed commit and a clean worktree. Build the compatible API and
   worker candidate locally, but do not push the production branch yet.
2. Confirm a current Supabase backup or point-in-time recovery (PITR) window and record the
   recovery timestamp. Do not begin without verified recovery coverage.
3. Record current Render API/worker deploy IDs and environment configuration. Confirm
   `INVENTORY_AUTO_DEDUCT=false` is ready for the maintenance window. Confirm Render
   auto-deploy is disabled for the API, sync worker, and print worker before any authorized
   push; otherwise a branch push could deploy the new runtime against the old schema.
4. Run the read-only schema/data preflight:

   ```text
   npm run migrate:ps-462-inventory-preparation
   ```

5. Record only its aggregate schema state, inventory-row count, ledger-row count, ledger
   quantity, zero-quantity count, and incomplete-identity count. Do not export customer rows.
6. Abort if the database is unreachable, the snapshot cannot complete, or any unexpected
   partial schema state cannot be explained.

## Maintenance and application

1. Put the user-facing app into maintenance mode. Stop the API, sync worker, and print worker
   so no inventory-ledger writer remains active.
2. Set and verify `INVENTORY_AUTO_DEDUCT=false`, and re-verify auto-deploy is disabled on all
   three Render services. Preserve logs and the preflight output.
3. Only with separate push approval, push the exact reviewed production branch while all
   writers remain stopped. Confirm no Render service started an automatic deployment.
4. Apply only `0073` with the exact double confirmation:

   ```text
   npm run migrate:ps-462-inventory-preparation -- --apply --confirm=apply-ps-462-inventory-preparation-0073 --maintenance-confirm=api-workers-stopped-inventory-auto-deduct-disabled
   ```

5. The operator uses one transaction, a five-second lock timeout, a sixty-second statement
   timeout, and before/after aggregate snapshots. It must report
   `inventory_and_ledger_data_unchanged=true`.
6. Do not apply 0074. Do not apply the correction packet. Do not reopen old-runtime writers.

## Immediate deployment and verification

1. Manually deploy the exact reviewed PS-462-compatible API and workers while maintenance
   remains on. Do not use a generic "latest" deploy when the commit cannot be verified.
2. Run the read-only preflight again. All identity columns, the nonzero constraint, the three
   enabled triggers, the source-identity index, and the legacy `stock_qty` column must be present.
3. Verify Render health/readiness and worker heartbeat without invoking providers, purchasing
   labels/postage, notifying marketplaces, or mutating production inventory/order/shipment data.
4. Keep `INVENTORY_AUTO_DEDUCT=false` until the API/worker commit parity and schema readiness
   are confirmed. Re-enable it only under its own approved rollout step.
5. Reopen traffic only when the compatible runtime is healthy and no new identity-guard errors
   appear in logs.

## Abort and compatibility rollback

- If the `0073` transaction fails or reports `PS462_PREPARATION_DATA_CHANGED`, leave traffic
  stopped. The transaction rolls back; investigate before retrying.
- If `0073` commits but the compatible runtime cannot deploy, keep maintenance on and run:

  ```text
  npm run rollback:ps-462-inventory-preparation -- --confirm=rollback-ps-462-inventory-preparation-0073 --maintenance-confirm=api-workers-stopped-inventory-auto-deduct-disabled
  ```

- That rollback removes only the new insert-identity trigger. It leaves additive columns,
  the nonzero constraint, the identity index, and UPDATE/DELETE/TRUNCATE immutability intact.
  It refuses to run after `stock_qty` has been removed by cutover.
- Redeploy the recorded prior runtime, verify health, then reopen traffic. Any legacy write
  after compatibility rollback invalidates the old correction packet; regenerate the
  read-only plan before another rollout attempt.

## Success evidence

- Exact candidate and deployed API/worker SHAs.
- Verified backup/PITR timestamp.
- Operator preflight and application output with unchanged aggregate snapshots.
- Post-application schema readiness and Render health/worker evidence.
- Confirmation that no correction, `0074`, labels, postage, marketplace notifications,
  production order/shipment mutation, or historical ledger rewrite occurred.
