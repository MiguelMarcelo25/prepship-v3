# PS-462 phase-1 inventory preparation runbook

This runbook prepares and verifies additive inventory migration `0075` and monthly-storage
identity migration `0077`. It does not authorize or perform correction movements, the
`0076` cutover, a Git push, or a
Render deployment.

The prior packet is historical and must not authorize production work. A fresh read-only discrepancy report
and correction packet are required at the exact release SHA. Completing
phase 1 does not authorize reopening customer traffic on the ledger-reading runtime. A production
window must either continue into separately approved correction and cutover procedures or
use the phase-1 compatibility rollback and restore the prior runtime.

## Ownership and sequencing risk

- Schema authorities: `drizzle/0075_inventory_quantity_sot.sql` and
  `drizzle/0077_ps462_billing_storage_month.sql`.
- Operator adapter: `scripts/ps-462-inventory-preparation-operator.ts`; it adds no schema
  decisions and verifies the authoritative SQL.
- Imperfect-data entry point: legacy inventory-ledger writers omit `source_entity` and
  `source_id`. The `0075` insert guard intentionally rejects those writes.
- Therefore, do not apply `0075` while the old API or workers can write. Use a maintenance
  window with the compatible PS-462 runtime built and ready for immediate deployment.

The repository uses explicit late-numbered migration operators; `0075` and `0077` are outside
`drizzle/meta/_journal.json`. Do not assume `drizzle-kit migrate` will discover them, and do
not apply it through an unrecorded Dashboard edit.

## Approval boundary

This prepared procedure is not production-SQL approval. Before execution, DJ must clearly
approve all production actions: the `0075` + `0077` application, the named maintenance window,
and the compatible API/worker deployment. Correction movements and `0076` require later,
separate approvals.

## Preflight — read only

1. Confirm the exact reviewed commit and a clean worktree. Build the compatible API and
   worker candidate locally, but do not push the production branch yet.
2. Confirm the exact correction packet and phase-2 cutover procedures are reviewed and
   ready for separate approval. If they are not ready, do not start this production window;
   validate phase 1 only in a non-production database.
3. Confirm a current Supabase backup or point-in-time recovery (PITR) window and record the
   recovery timestamp. Do not begin without verified recovery coverage.
4. Record current Render API/worker deploy IDs, the current Vercel production deployment,
   and environment configuration. Confirm
   `INVENTORY_AUTO_DEDUCT=false` is ready for the maintenance window. Confirm Render
   auto-deploy is disabled for the API, sync worker, and print worker and Vercel production
   auto-deploy/promotion is controlled before any authorized push; otherwise a branch push
   could deploy either new runtime against the old schema.
5. Run the read-only schema/data preflight:

   ```text
   npm run migrate:ps-462-inventory-preparation
   ```

6. Record only its aggregate schema state, inventory-row count, ledger-row count, ledger
   quantity, zero-quantity count, and incomplete-identity count. Do not export customer rows.
7. Abort if the database is unreachable, the snapshot cannot complete, or any unexpected
   partial schema state cannot be explained.

## Maintenance and application

1. Put both PrepShip and Client Portal user-facing production surfaces into maintenance mode.
   Stop the API, sync worker, and print worker so no inventory-ledger writer remains active.
2. Set and verify `INVENTORY_AUTO_DEDUCT=false`, and re-verify auto-deploy is disabled on all
   three Render services. Preserve logs and the preflight output.
3. Only with separate push approval, push the exact reviewed PrepShip and Client Portal
   production branches while all writers remain stopped. Confirm neither Render nor Vercel
   started an automatic production deployment.
4. Apply only additive `0075` + `0077` from the PrepShip repository with the exact double
   confirmation. Do not run Client Portal migrations: PrepShip is the sole schema-migration
   owner for this coordinated release. The operator
   fails closed if a client already has multiple storage lines in one UTC calendar month:

   ```text
   npm run migrate:ps-462-inventory-preparation -- --apply --confirm=apply-ps-462-preparation-0075-0077 --maintenance-confirm=api-workers-stopped-inventory-auto-deduct-disabled
   ```

5. The operator uses one transaction, a five-second lock timeout, a sixty-second statement
   timeout, and before/after aggregate snapshots. It must report
   `inventory_and_ledger_data_unchanged=true`.
6. Do not apply 0076. Do not apply the correction packet. Do not reopen old-runtime writers.

## Maintenance-only deployment and verification

1. Manually deploy the exact reviewed PS-462-compatible API and workers while maintenance
   remains on, then deploy the exact reviewed Client Portal SHA to a non-promoted Vercel
   deployment without running Client Portal database migrations. Do not use a generic "latest"
   deploy when the commit cannot be verified.
2. Run the read-only preflight again. All identity columns, the nonzero constraint, the three
   enabled triggers, the source-identity index, and the legacy `stock_qty` column must be present.
3. Verify Render health/readiness, worker heartbeat, and the non-promoted Vercel deployment
   without invoking providers, purchasing
   labels/postage, notifying marketplaces, or mutating production inventory/order/shipment data.
4. Keep `INVENTORY_AUTO_DEDUCT=false`. Do not reopen traffic after phase 1 until the fresh
   correction packet is separately approved and quantity parity is proven.
5. Continue only into the separately approved correction and `0076` procedures in the same
   maintenance window. If either approval or gate is unavailable, use the compatibility
   rollback below, restore the prior runtime, verify it, and only then reopen traffic.
6. Re-enable inventory auto-deduction and reopen traffic only after the full cutover has its
   own approval and passes quantity parity, commit parity, health, and worker-readiness checks.

## Abort and compatibility rollback

- If the `0075` + `0077` transaction fails or reports `PS462_PREPARATION_DATA_CHANGED`, leave traffic
  stopped. The transaction rolls back; investigate before retrying.
- If preparation commits but the compatible runtime cannot deploy, keep maintenance on and run:

  ```text
  npm run rollback:ps-462-inventory-preparation -- --confirm=rollback-ps-462-inventory-preparation-0075 --maintenance-confirm=api-workers-stopped-inventory-auto-deduct-disabled
  ```

- That rollback removes only the new insert-identity trigger. It leaves additive columns,
  the nonzero constraint, the identity index, and UPDATE/DELETE/TRUNCATE immutability intact.
  It refuses to run after `stock_qty` has been removed by cutover.
- Redeploy the recorded prior runtime, verify health, then reopen traffic. Any legacy write
  after compatibility rollback invalidates the old correction packet; regenerate the
  read-only plan before another rollout attempt.

## Success evidence

- Exact candidate and deployed API/worker and Client Portal/Vercel SHAs.
- Verified backup/PITR timestamp.
- Operator preflight and application output with unchanged aggregate snapshots.
- Post-application schema readiness and Render health/worker evidence.
- Confirmation that no correction, `0076`, labels, postage, marketplace notifications,
  production order/shipment mutation, or historical ledger rewrite occurred.
