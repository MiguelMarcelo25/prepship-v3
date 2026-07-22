# PS-462 append-only inventory correction and phase-2 cutover

Status: **prepared only — no production correction, migration, push, or deploy is authorized**.

This runbook continues the closed maintenance window described in
`ps-462-inventory-preparation.md`. Do not reopen traffic after phase 1. The same window must
either complete the reviewed correction and `0076`, or restore phase-1 compatibility before
the prior runtime is allowed to serve traffic.

## Authority and invariants

- Discrepancy authority: `buildInventoryReconciliationPlan`.
- Correction packet authority: `buildInventoryCorrectionPlan`.
- Mutation authority: `applyInventoryMovementInTransaction`.
- Schema/cutover authority: `0076_inventory_quantity_cutover.sql`.
- Corrections append signed `inventory_ledger` movements. They never update `inventory.stock_qty`.
- `inventory_ledger` is never updated, deleted, or truncated.
- Orders, shipments, labels, postage, and marketplace notifications are out of scope.
- Never deploy an unpinned "latest" build. Record and verify the exact Git SHA for every service.

## Required evidence before the window

1. A fresh correction packet generated at the exact candidate SHA, with reviewer-approved
   `sourceReport.planHash` and `movementsFile.sha256`.
2. A tested database backup/PITR point and the exact recovery owner.
3. Render auto-deploy disabled for API and both workers; Vercel production auto-promotion
   controlled for Client Portal.
4. The exact current and candidate SHAs recorded for API, worker, print worker, and Client Portal.
5. `ops/rollback/ps-462_inventory_preparation_compatibility_rollback.sql` and
   `ops/rollback/ps-462_inventory_quantity_forward_rollback.sql` reviewed and immediately
   available.
6. A named operator and observer, plus a separately recorded approval for the correction and
   for `0076`. Preparation of this runbook is not that approval.

## Closed-window sequence

1. Enable the maintenance gate. Stop API, worker, and print-worker inventory writers. Set
   `INVENTORY_AUTO_DEDUCT=false`, and record the operator who verified all four facts.
2. Run the phase-1 operator in read-only mode, then apply `0075` + `0077` only with their exact confirmation.
   Keep traffic closed.
3. Run the correction preflight (no mutation):

   ```text
   npm run inventory:correction:apply
   ```

   Compare its plan hash, movement SHA, row count, and signed quantity with the reviewed packet.
   Any difference stops the rollout and requires a new packet and review.
4. Only after a separate production-data approval, execute the append-only correction with the
   exact reviewed values:

   ```text
   npm run inventory:correction:apply -- --apply \
     --confirm=apply-ps-462-inventory-correction \
     --maintenance-confirm=api-workers-stopped-inventory-auto-deduct-disabled \
     --plan-hash=<reviewed-plan-hash> \
     --movements-sha=<reviewed-movements-sha> \
     --created-by=<named-operator>
   ```

   The operator locks deterministically, rebuilds the canonical plan inside the transaction,
   appends through the canonical movement service, and rolls back the entire batch unless global
   legacy/ledger parity becomes zero.
5. Run the phase-2 preflight (no mutation):

   ```text
   npm run migrate:ps-462-inventory-cutover
   ```

   It must report `ready: true`, zero mismatches, zero zero-quantity ledger rows, and all phase-1
   identity/immutability guards present.
6. Only after separate `0076` approval and confirmation that the forward rollback was reviewed:

   ```text
   npm run migrate:ps-462-inventory-cutover -- --apply \
     --confirm=apply-ps-462-inventory-cutover-0076 \
     --maintenance-confirm=api-workers-stopped-inventory-auto-deduct-disabled \
     --rollback-confirm=forward-rollback-reviewed
   ```

7. Deploy only the exact recorded compatible candidate SHAs. First deploy and verify the Render
   API and both workers while maintenance remains on; then deploy the Client Portal candidate to
   Vercel without running Client Portal database migrations, verify its SHA against the reviewed
   Client Portal commit, and only then promote it. PrepShip remains the sole schema-migration owner.
   Verify deep health, readiness, inventory reads, movement append behavior, and ledger guards.
8. Keep `INVENTORY_AUTO_DEDUCT=false` until those checks pass. Enable it and reopen traffic only
   with the separately recorded release authorization.

## Failure and rollback

- Before `0076`: keep writers stopped. If the correction transaction failed, it made no partial
  change. If an already-committed correction must be reversed, prepare and separately approve an
  append-only inverse movement packet; never mutate ledger history. Restore phase-1 compatibility
  before deploying the prior runtime.
- After `0076`: keep writers stopped. Run
  `ops/rollback/ps-462_inventory_quantity_forward_rollback.sql`, verify stock/ledger parity and
  ledger immutability, then deploy the exact prior SHA. Do not run the phase-1 compatibility
  rollback after `0076`.
- At any point: if hashes, schema, counts, quantities, or service SHAs differ from the record,
  stop. Preserve the maintenance gate and collect evidence before choosing the recovery path.

## Closeout record

Record approvals, operators, timestamps, exact Render and Vercel SHAs/deployment IDs, correction
plan hash, movements SHA, before and after ledger counts/sums, migration output, health evidence,
and whether the kill switch and traffic gate were restored. State explicitly whether any
production movement was appended.
