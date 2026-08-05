#!/usr/bin/env node
/**
 * Mandatory SOT/backend-truth/no-wrapper guard pack.
 *
 * PS-335: this is CI/Hermes review wiring only. The commands below are
 * offline/static guards and must stay free of provider calls, DB writes, label
 * creation, marketplace notifications, and shipped/cancelled mutations.
 */
import { spawnSync } from 'node:child_process';

const REQUIRED_GUARDS = [
  'test:ps-464-architecture-boundaries',
  'test:ps-305-authority-drift',
  'test:rate-source-of-truth',
  'test:ps-466-automation-controls',
  // PS-465 hazmat. These existed and passed but nothing ran them -- not this
  // pack, not test:master:shipping -- so the whole dangerous-goods compliance
  // surface could rot undetected during an unrelated refactor, which is exactly
  // how non-cert guards have been lost before. They are hermetic: the migration
  // integration guard uses PGlite in-process, the rest read files and modules,
  // and all three were verified under this runner's OFFLINE_GUARD_ENV (which
  // forces an unreachable DATABASE_URL) before being added here.
  'test:ps-465-hazmat',
  'test:mock-hazmat-label',
  'test:ps-465-466-migration-rollout',
  // PS-462 canonical inventory ledger. Same story as the hazmat block above, and
  // the third time this pattern has cost a review: eleven proofs existed and
  // passed -- including three migrated-database integrations -- and nothing ran
  // any of them, so the ledger cutover that removed every competing quantity
  // column could rot undetected. Inventory balances feed Billing and the Client
  // Portal, so a silent regression here is a money-path regression.
  // Hermetic: verified green under this runner's OFFLINE_GUARD_ENV before being
  // added, the integrations use PGlite in-process, and the rest read files and
  // modules. Aggregate entry on purpose -- it also carries PS-439's inventory
  // source-of-truth guard and concurrency integration, which had the same gap.
  'test:ps-462-inventory-sot',
  // PS-442 sync lane fairness, watermarks and durable state. Fourth instance of
  // the same pattern in one day: the guard existed, passed, and ran nowhere --
  // and both PS-442 commits shipped with [skip ci], so it had never run in CI
  // either. It pins the busy-defer job set, the inventory product cursor keys,
  // the per-account watermark triples and the Walmart token abort, i.e. exactly
  // the starvation and freeze behaviour that is invisible until a lane stalls in
  // production. Hermetic: verified green under OFFLINE_GUARD_ENV before adding.
  'test:ps-442-sync-fairness',
  // ── Ungated-guard sweep, batch 1 of N: the money-path boundaries ──
  //
  // A sweep of every test: script against this pack, ci.yml and the deploy
  // workflow found 798 scripts, 94 gated, and 249 ungated ones that touch money
  // or safety. test:master:all-safe gates nowhere either -- by design, since it
  // exits 0 and reports a baseline diff rather than passing or failing, so it
  // cannot serve as a gate. The practical consequence is that the DEFAULT state
  // of a guard in this repo is ungated, and the four added above were simply the
  // ones that happened to cost a review.
  //
  // These six are batch 1 because they sit on the purchase and rate-proof
  // boundaries -- the places where a regression spends real money rather than
  // rendering something wrong. Each was verified green under OFFLINE_GUARD_ENV
  // and timed before admission, per this pack's own rule; all six are ~1.2s.
  //
  // Deliberately a small batch. Admitting 249 at once would put unknown runtime
  // and unknown hermeticity in front of every deploy, and one flake would block
  // all shipping. Promote in batches, verify each, keep the gate trustworthy.
  'test:ps-098-shipping-purchase-boundary',
  'test:selected-rate-proof-boundary',
  'test:ps-094-rate-selection-proof',
  'test:ps-095-selected-rate-proof-pass-through',
  'test:ps-462-billing-sot',
  'test:recalculate-best-rate-strict',
  // ── Batch 2: label / postage integrity, plus two guards the sweep found RED ──
  //
  // print-to-queue-selected-rate-proof and ps-105-backend-rate-snapshot-id were
  // both FAILING on stable when the sweep ran them. Neither was a money-path
  // hole; both had rotted, and neither could be noticed because nothing ran them:
  //   - the input object was hoisted out of the createLabelV2 call so the durable
  //     receipt-resume path could share it. `{ ...labelInput, ... }` still reaches
  //     createLabelV2, so every pinned field still travels.
  //   - the /browse route went multi-line AND gained an authz middleware
  //     (requireBusinessRoutePolicy). The route got STRONGER and the guard,
  //     matching an adjacent one-line form, called that a failure.
  // Both regexes were repointed to match the chain rather than the call shape,
  // then mutation-checked: deleting the ...labelInput spread fails both. A
  // repointed guard that can no longer fail would be worse than the red it
  // replaced.
  //
  // ps-186-test-label-authority leads this batch deliberately: it is what keeps a
  // test from buying real postage.
  'test:ps-186-test-label-authority',
  'test:ps-053-print-queue-atomic',
  'test:print-queue-in-progress-recovery',
  'test:ps-288-label-recovery',
  'test:ps-108-parcelguard-insured-best-rate',
  'test:ps-126-parcelguard-schedule-premium',
  'test:ps-125-hugrab-zero-insurance-premium',
  'test:ps-104-print-queue-selected-rate-proof-pass-through',
  'test:print-to-queue-selected-rate-proof',
  'test:ps-105-backend-rate-snapshot-id',
  // ── Batch 3: authority, shipped/cancelled safety, scope ──
  //
  // The lockdown in AGENTS.md is the loudest rule in this repo, and until now
  // nothing ran the guards that enforce it. ps-128-external-shipped-label-block
  // and ps-129-upstream-cancellation-hold protect the shipped/cancelled surface;
  // ps-422-shipping-quote-authorization sits on the purchase authorization
  // boundary; the ps-176/178/181 trio pins where authority is allowed to live.
  //
  // A written rule that nothing executes is a convention, not a control. These
  // are the executable half.
  //
  // All twelve verified green and hermetic under OFFLINE_GUARD_ENV before
  // admission; no reds in this batch, unlike batch 2.
  'test:ps-422-shipping-quote-authorization',
  'test:ps-181-backend-admin-authority',
  'test:ps-176-queue-route-authority',
  'test:ps-416-billing-fail-closed',
  'test:ps-178-fe-authority-ratchet',
  'test:ps-128-external-shipped-label-block',
  'test:ps-129-upstream-cancellation-hold',
  'test:ps-192-shipped-external-provider',
  'test:ps-168-scope-sql',
  'test:settings-read-scope',
  'test:ps-083-direct-carrier-scope',
  'test:store-order-import-batch-dedupe',
  // ── Batch 4: marketplace confirmation, fulfillment, order lifecycle ──
  //
  // inventory-auto-deduct guards the INVENTORY_AUTO_DEDUCT kill switch, which
  // AGENTS.md names as a locked surface; the confirmation pair covers telling a
  // marketplace a shipment happened, which is an external side effect that
  // cannot be taken back once sent.
  //
  // Two candidates were tested and deliberately NOT admitted:
  //   test:inventory-source-of-truth -- a bare alias for test:ps-462-inventory-sot,
  //     already gated at de52b19c. Admitting it would have paid its 16s twice for
  //     zero additional coverage.
  //   test:ps-067-billing-external-fulfilled -- RED on stable. It pins
  //     `billingShipDateSql`, a read-time SQL fallback that PS-434 replaced with
  //     the persisted billingSourceCalendar.actualActivityDay column. Almost
  //     certainly rot rather than a billing defect (shipDate: row.billingShipDate
  //     and fulfilledAt both survive), but repointing it means re-expressing the
  //     property against the calendar WRITER, and I have not verified the
  //     fallback chain there. Not gating a red, and not repairing one I have not
  //     traced to the end.
  'test:inventory-auto-deduct',
  'test:walmart-confirmation:payload',
  'test:ebay-confirmation:mocked',
  'test:ps-402-fulfillment-conflict',
  'test:ps-411-effective-lifecycle-edit-lock',
  'test:ps-387-effective-order-status-sot',
  'test:ps-199-walmart-po-resolution',
  'test:ps-194-confirm-printed-persistence',
  'test:inventory-history-dedupe',
  'test:ps-401-shopify-order-total',
  // ── Batch 5: rate accuracy, insurance, best-rate contracts ──
  //
  // Two more reds found and repaired, both rot, both caused by improvements:
  //   ps-083-shipp-insurance reported FOUR money-path failures ("resolved
  //     insurance provider: got false, want true") produced by ONE added option.
  //     It sliced the fanout call between two text anchors; the options object
  //     gained `priority: 'interactive'`, the end anchor stopped matching,
  //     indexOf returned -1, and every check ran against an empty string. The
  //     insurance forwarding was never broken. Anchored on the start of the
  //     options object so extra fields cannot manufacture a red.
  //   ps-050-rate-accuracy pinned the exact variable name at the persist site and
  //     broke when stampRateSourceDisplay was inserted into the chain. Each step
  //     wraps the previous, so the metadata it protects survives; only the final
  //     binding was renamed. Now pins that a stamped-best derivative is persisted.
  // Both mutation-checked: removing the insurance forwarding fails the first,
  // persisting a raw best fails the second.
  'test:ps-050-rate-accuracy',
  'test:ps-050-rate-exactness',
  'test:rates-multi-durable-snapshot',
  'test:rate-system-hardening',
  'test:ps-072-hugrab-insurance',
  'test:ps-083-shipp-insurance',
  'test:ps-082-browse-rate-reconcile',
  'test:batch-recalculate-best-rate',
  'test:ps-286-awaiting-row-rate-truth',
  'test:ps-286-applied-rate-sync',
  'test:best-rate-saved-display-contract',
  'test:ps-102-best-rate-workflow-dto',
  // ── Batch 6: label normalization, external certification, rate cache ──
  //
  // All twelve candidates passed first time -- the first batch with no reds since
  // batch 3. Eleven admitted: test:print-queue-label-normalization was dropped as
  // a bare alias for test:ps-287-print-queue-label-normalization. Second alias
  // caught this sweep (the first was test:inventory-source-of-truth in batch 4),
  // so checking the script body before promoting is now part of the routine --
  // an alias costs its runtime twice and adds no coverage.
  'test:ps-056-external-label-certification',
  'test:ps-084-label-size-normalize',
  'test:ps-287-print-queue-label-normalization',
  'test:ps-286-label-url-backfill',
  'test:carrier-enable-disable-label',
  'test:ps-099-create-print-shipp-label-output',
  'test:ps-099-orders-rate-cache-first',
  'test:rates-multi-cache',
  'test:ps-081-rate-sync',
  'test:ps-057-hugrab-ground-saver',
  'test:multi-sku-product-dims-rate-fallback',
  // ── Batch 7: proof forwarding, markup, insurance display ──
  //
  // NOT admitted: test:ps-380-billing-summary-cache-freshness, RED. It requires
  // the literal log line "[billing] refreshing stale or incomplete summary
  // metrics from billing_line_items" in reporting-metrics.ts, and that string is
  // GONE -- not renamed, absent, along with every other [billing] log in the
  // file. reporting-metrics.ts:626 now says the refresh path "never touches
  // billing_line_items", so the strategy this guard describes appears to have
  // been replaced rather than reformatted.
  //
  // That makes it unlike the five rots repaired so far. Those pinned syntax
  // around behaviour that demonstrably survived, so repointing was safe and
  // mutation-checkable. Here the behaviour itself may have moved, and I cannot
  // repoint a guard without knowing what property is left to pin. Left red and
  // documented, like ps-067.
  'test:batch-send-proof-forwarding',
  'test:ps-198-rate-quote-proof-passthrough',
  'test:ps-391-shipstation-addons-markup',
  'test:ps-170-account-capability-insurance',
  'test:ps-197-effective-insurance-display',
  'test:ps-190-label-conflict-codes',
  'test:ps-124-backend-combined-best-rate',
  'test:ps-385-rate-adjustment-classification',
  'test:ps-386-stale-rate-aliases',
  'test:ps-134-billing-ref-rates',
  'test:ps-084-direct-carrier-print-queue',
  // ── Batch 8: order identity, shipping state, row money display ──
  // Twelve, all green and hermetic first time. Nothing notable -- which is worth
  // recording as much as the reds are: the ungated population is not uniformly
  // rotten, and batches 3, 6 and 8 came back completely clean.
  'test:ps-388-order-source-identity-sot',
  'test:ps-349-order-shipping-state',
  'test:ps-177-row-money-display',
  'test:ps-177-queue-sku-identity',
  'test:ps-187-backend-test-rate-fixture',
  'test:ps-126-zip4-rate-parity',
  'test:ps-121-group-rate-recalc',
  'test:ps-120-rate-job-status',
  'test:ps-165-order-shipping-display',
  'test:ps-173-order-row-workflow',
  'test:shipment-tracking-retirement',
  'test:print-queue-timing-proof',
  // ── Batch 9: the two billing-export guards Hermes found rotted, now repaired ──
  //
  // Both were RED on stable and ungated, which is the same pair of facts every
  // time. Hermes' exact-head audit found them while scoring PS-434 and correctly
  // called them "rotted guard assertions, not verified runtime billing defects".
  //   billing-invoice-xlsx-layout expected header 'Fulfillment Fee'; the column
  //     was re-labelled 'Total' while KEEPING key 'fulfillmentFee', so the data
  //     binding never moved -- only the operator-visible label.
  //   ps-217-billing-export-box-fields required the literal `if (rowTotal > 0)`.
  //     The owner now reads `Number.isFinite(rowTotal) && rowTotal !== 0` and
  //     returns roundMoney(rowTotal). Every difference is a strengthening -- signed
  //     totals survive, NaN cannot be returned as money, rounding goes through
  //     PS-457's single owner -- so the guard was demanding the WEAKER predicate
  //     back. A stale guard does not just miss regressions; it can argue for them.
  // Both repointed to the property rather than the spelling, and mutation-checked:
  // re-labelling the column fails the first, weakening !== 0 back to > 0 fails the
  // second. ps-208 added alongside them as the third ungated invoice-XLSX guard.
  'test:billing-invoice-xlsx-layout',
  'test:ps-217-billing-export-box-fields',
  'test:ps-208-billing-calendar-day-invoice-xlsx',
  // ── Batch 10: billing. Three more reds, all rot, all from improvements ──
  //
  // The billing tier has the worst rot rate of the sweep: 5 reds in 15 sampled,
  // against 6 in the other ~90. Not because billing is fragile -- because it has
  // been refactored hardest, and these guards pin source text.
  //   ps-370 pinned roundCents(persisted). PS-457 consolidated cent rounding into
  //     one owner; roundCents no longer exists in src at all. Third guard broken
  //     by that single rename, after ps-217 and the PS-434 pair.
  //   ps-310 required `skus:` to sit immediately beside itemSummary.itemSkus. A
  //     credit-note branch ("Original invoice N") was inserted between them.
  //   hugrab-shipping-floor pinned clearCachedReads('fetchBillingSummary',
  //     'fetchShippingMarginAnalytics'), replaced by the typed
  //     invalidateBillingReads({ summary, shippingMargin }) and made conditional
  //     on data.apply so a dry-run preview stops invalidating caches it never
  //     changed. Two improvements the old assertion scored as a failure.
  // All three repointed to the property, all three mutation-checked.
  'test:ps-370-selected-rate-cost-parity',
  'test:ps-310-billing-export-sku-qty',
  'test:billing-hugrab-shipping-floor',
  'test:markup-single-source',
  'test:billing-formula',
  'test:ps-364-billing-selected-rate-sot',
  'test:ps-372-billing-read-divergence',
  'test:ps-362-billing-detail-sot-export',
  'test:ps-798-per-account-billing',
  'test:ps-207-shipped-box-billing-policy',
  'test:ps-373-prorated-storage-billing',
  'test:billing-client-scope',
  // ── Batch 11: void labels, rate proof, print queue ──
  //
  // ps-203 was RED and is repaired here. It pinned the local `rawAmountBest`,
  // renamed to `persistedFinalizedBest` when the raw restore moved to AFTER
  // finalization so proof stamps survive the spread -- a correctness reordering.
  // The second-best path gained the same treatment, so there are now two strip
  // sites where the guard pinned one. Double-markup protection was never absent.
  // Mutation-checked: removing both markup deletes fails it.
  //
  // NOT admitted: test:ps-202-direct-label-owner, RED and deliberately unrepaired.
  // It pins `enqueueFulfillmentDeductions({ order, shipmentId, source: 'label' })`,
  // which no longer exists anywhere in src -- PS-450 replaced it with the
  // fulfillment outbox (enqueueInventoryDeduction). labels.ts imports the new
  // owner and passes it to the bundle-member fan-out, but I could not establish
  // where the PRIMARY deduction is enqueued from the label path. Almost certainly
  // rot like the other ten, but "almost certainly" is not evidence, this is
  // inventory behind the INVENTORY_AUTO_DEDUCT kill switch, and repointing it
  // would mean inventing an assertion about a path I have not traced. Third red
  // left standing with its diagnosis, after ps-067 and ps-380.
  'test:ps-203-best-rate-universe',
  'test:ps-399-shipstation-void-label-id',
  'test:ps-219-void-label-ui',
  'test:ps-209-label-owner-slice',
  'test:ps-295-house-customer-rate-proof',
  'test:ps-299-finalized-best-rate',
  'test:ps-348-pre-expiry-rate-refresh',
  'test:ps-354-print-queue-stale-job',
  'test:ps-214-hugrab-universal-insurance',
  'test:ps-468-invoice-csv',
  'test:ps-406-shopify-rates-labels',
  // ── Batch 12: rate proof, print-queue recovery, insurance proof ──
  //
  // ps-166-orders-rate-proof was RED because it required OrdersView to IMPORT
  // and CALL buildBestTestRateForShipment. The import has since been narrowed to
  // display constants under the comment "Mock-label display constants only; the
  // browser never fabricates rate money" -- PS-313/PS-316 enforced. The guard was
  // demanding the frontend keep minting rate money.
  //
  // Third guard today found asserting the defect rather than the rule, after the
  // CP-045 company override and ps-217's `rowTotal > 0`. Repairing any of them by
  // making the code match would have reintroduced the bug AND gone green doing
  // it. Inverted to pin the law's actual direction, then mutation-checked by
  // reintroducing the builder call.
  'test:ps-166-orders-rate-proof',
  'test:best-rate-boundary',
  'test:ps-419-strict-rate-snapshot',
  'test:ps-400-print-queue-retry-recovery',
  'test:ps-401-print-queue-mixed-success',
  'test:ps-403-print-queue-worker-recovery',
  'test:print-queue-merge-claim-deadline',
  'test:ps-403-print-queue-pdf-chunks',
  'test:ps-404-hugrab-insurance-proof',
  'test:ps-402-hugrab-shipped-insurance-breakdown',
  'test:ps-411-bulk-assign-terminal-lock',
  'test:single-sku-default-qty-scope',
  // ── Batch 13: dashboard/inventory policy, print-queue hygiene, search ──
  //
  // ps-150-reorder-policy was RED for two unrelated reasons in one guard:
  //   - it required DashboardView to import '../../../../src/lib/...' and run the
  //     policy itself. PS-325 moved dashboard metrics to a backend read model and
  //     PS-464's boundary law forbids that import, so the assertion demanded an
  //     architecture violation the repo had already removed. Inverted: the view
  //     must NOT reach into src/ and must NOT compute. That is a stronger pin than
  //     the original -- a view that cannot reach the policy cannot drift from it.
  //   - it required `stock: stockQty` on the backend call. PS-462 renamed that to
  //     inventoryQuantity when it collapsed the split balances into one canonical
  //     ledger quantity. Delegation unchanged; pinned the call and keys instead of
  //     the local supplying stock.
  // Mutation-checked in both directions: the FE computing fails it, the route not
  // delegating fails it.
  'test:ps-150-reorder-policy',
  'test:ps-459-rate-on-ingest-cache',
  'test:best-rate-dims',
  'test:shipp-rate-retry',
  'test:print-queue-hygiene',
  'test:print-queue-sku-grouping',
  'test:awaiting-onhold-backsync',
  'test:ps-166-orders-rate-cells',
  'test:ps-210-global-orders-search',
  'test:ps-404-international-order-indicator',
  'test:ps-420-print-queue-progress',
  'test:label-coldstart-import',
  // ── Batch 14: client/store scope, inventory ledger, dashboard windows ──
  //
  // dashboard-orders-units was RED requiring DashboardView -- the FRONTEND -- to
  // contain `dateOffsetFrom(currentTo, Math.min(6, rangeLengthDays - 1))`: the
  // browser deriving a reporting window. PS-325 moved it to
  // reporting-window-presets.ts and the view now relays the backend window.
  //
  // Third guard in three batches demanding the frontend own a backend
  // computation, after ps-166 (rate builders) and ps-150 (reorder policy). Each
  // was correct when written and none was updated when the source-of-truth passes
  // moved the work -- because nothing ran them to say so. That is the clearest
  // argument in this whole sweep for gating: these did not drift quietly, they
  // drifted into asserting the opposite of the architecture.
  //
  // Inverted and mutation-checked both ways: the FE deriving fails it, the owner
  // not computing fails it.
  'test:dashboard-orders-units',
  'test:inventory-ledger-balance',
  'test:client-store-scope',
  'test:dashboard-client-scope',
  'test:analysis-client-scope',
  'test:inventory-client-scope',
  'test:marketplace-order-auth-cors',
  'test:inventory-default-view',
  'test:batch-header-package-size',
  'test:inventory-history-date-range-total',
  'test:inventory-history-table-pagination',
  'test:ps-438-rate-recalculation-progress',
  // ── Batch 15: selected-rate cost SOT, inventory ledger, storage proof ──
  //
  // ps-381 was RED on one clause: `result.cost` became `durableResult.cost` when
  // the durable receipt-resume path was added and the local was renamed to
  // distinguish it from the live purchase result. Its other three clauses matched
  // verbatim, which is what isolated this to a rename rather than a lost stamp.
  // Repointed and mutation-checked.
  //
  // THREE REDS NOT REPAIRED, each needing a trace I have not done:
  //   test:ps-383-billing-storage-proof-migration -- two failures, "storage charge
  //     is skipped when proof durability fails" and "generated totals move only
  //     after proof+line transaction commits". Both are durability ORDERING
  //     properties, not string shapes. Whether the ordering still holds under a
  //     different implementation is a real question about billing correctness and
  //     deserves tracing, not a regex nudge.
  //   test:daily-orders-trend-count -- "backend payload type includes count".
  //   test:dashboard-client-sku-filter -- "the dashboard load effect must re-run
  //     on selectedClientId", a React effect-dependency property; if that is
  //     genuinely gone it is a stale-data bug, and if the effect moved it needs
  //     repointing to wherever the dependency now lives.
  // Left red on purpose. Fourteen repairs today were each traced end to end
  // first; these three have not been, and a guess here is worth less than the red.
  'test:ps-381-selected-rate-cost-sot',
  'test:ps-370-selected-rate-cost-backfill',
  'test:ps-366-hugrab-shipping-rate-override',
  'test:ps-365-client-used-package-pricing',
  'test:ps-373-storage-proof',
  'test:ps-414-inventory-ledger',
  'test:inventory-repair-plan',
  'test:daily-orders-trend-total-line',
  'test:analysis-table-first',
  // PS-383 billing storage proof. Both its reds were rot from improvements:
  //   the prose log "storage line skipped because proof freeze failed" became a
  //     structured reportError('billing.storage_line.freeze_failed', ...), and the
  //     branch now also tracks finalized-lock skips.
  //   `generated += 1` became `generated += insertedStorageLines.length` -- the
  //     insert carries onConflictDoNothing and .returning()s the rows Postgres
  //     ACTUALLY persisted, so the old blind +1 over-counted on conflict.
  // Both skip-on-failure and commit-ordering still hold.
  //
  // The ordering check also gained real teeth here. It anchored on
  // indexOf('await db.transaction(async (tx) =>'), which matches an EARLIER
  // transaction in the same block, so it was comparing against the wrong one --
  // moving the storage increment before the storage transaction passed. Now
  // anchored on insertedStorageLines specifically. That flaw predated this sweep;
  // the mutation check is the only reason it surfaced.
  'test:ps-383-billing-storage-proof-migration',
  // ── Batch 16: carrier eligibility, recipient identity, billing detail ──
  //
  // Two repaired, both single-token rot:
  //   ps-106 required the literal `if (body.orderId)`. It became
  //     `if (body.orderId && orderForBrowse)` -- a narrowing, so eligibility runs
  //     only when the order actually loaded rather than on an id alone. The
  //     fail-open try/catch it pins is untouched.
  //   carrier-safe-recipient-name required `const carrierShipTo`. It is `let` now
  //     because the payload is reassigned further down. The binding keyword is not
  //     the property; name and company still come from carrierRecipient.
  // Both mutation-checked with the mutation confirmed applied first, after the
  // CRLF no-op traps earlier today.
  //
  // NOT admitted, not traced:
  //   test:ps-377-cancelled-billing-rows -- "empty billing message no longer says
  //     HUGRAB-only cancelled". A NEGATIVE assertion failing means the string it
  //     forbids is present again, or its target moved. Those are opposite
  //     conclusions and only a trace separates them.
  //   test:billing-line-item-warning-summary -- expects an exact JSX line
  //     including both props; needs the component read to know what replaced it.
  'test:ps-106-carrier-family-eligibility',
  'test:carrier-safe-recipient-name',
  'test:ps-363-billing-no-box-cost-alert',
  'test:billing-detail-ps040',
  'test:billing-edit-draft-cache',
  'test:carrier-suppression',
  'test:carrier-test-mode-seam',
  'test:carrier-fixture-schema',
  'test:awaiting-carrier-badge-nickname-fallback',
  'test:carrier-assigned-badge-palette',
  // ── Batch 17: billing overrides, status column, store connectors ──
  //
  // ps-393 was RED on two assertions, both worth recording:
  //   the CSV check restated 'Ship Date/Time (Los Angeles)' as a literal. PS-434
  //     renamed that header to 'Billing / Activity Date (Los Angeles)' when it
  //     split actual activity day from billing effective day. Second guard PS-434
  //     broke, after ps-067. Now imports INVOICE_SHIP_DATE_HEADER instead of
  //     restating it -- PS-393 owns the column ORDER, not the first column's name.
  //   the storage-key check pinned billing_detail_cols_v6 exactly. It is v7 now
  //     because a later column change bumped it, which is CORRECT: bumping resets
  //     saved column configs so a new column is visible rather than hidden behind
  //     stale localStorage. Pinning a literal turns the right action into a red,
  //     and bumping the guard to v7 would just defer the same break. Now asserts
  //     the key stays versioned and never regresses below the PS-393 reset.
  // Both mutation-checked with the mutation confirmed applied.
  'test:ps-393-billing-status-column',
  'test:ps-392-manual-billing-overrides',
  'test:ps-394-billing-qty-shipping-display',
  'test:ps-395-billing-review-resolution',
  'test:ps-396-cancelled-billing-no-charge',
  'test:ps-398-billing-custom-box-override',
  'test:ps-054-walmart-workflow',
  'test:shopify-store-connector',
  'test:ebay-nosku-title-fallback-grouping',
  'test:ps-405-shopify-shipping-spike',
  // ── Batch 18: the Rate Browser cluster ──
  //
  // Every rate the operator picks from is chosen here, so this whole cluster sits
  // under the PS-313 rate source-of-truth lockdown and none of it was gating.
  //
  // Three were RED, and all three had rotted in the SAME direction -- the code moved
  // TOWARD the source of truth and the guard was pinning the pre-move spelling:
  //   rate-browser-carrier-account-click: the sidebar count filtered on an FE-derived
  //     isBlockedRate(rate, order, shippingOptions). It now calls shouldHideRate ->
  //     rateBrowserShouldHideUnavailableRate -> readBackendEligibilityBlockReason, i.e.
  //     it READS the backend eligibility reason instead of recomputing eligibility in
  //     React. PS-316 exactly. Re-pinned at both ends: sidebar filters through the
  //     injected predicate and re-derives nothing, modal binds the canonical one.
  //   ps-390-rate-browser-country: required requestedCountry/canonicalCountry verbatim.
  //     Both are behind `orderForBrowse ? ... : ...` now, so on an order-backed browse
  //     the frontend's country is not even offered to the resolver -- a tightening the
  //     guard read as a break. Now checks canonical comes from the order ship-to,
  //     requested never does, and the two are not swapped.
  //   ps-206-rate-browser-full-coverage: PS-459 lifted the cached-only rule out of an
  //     inline `if` into the pure decideDirectCarrierCacheUse owner, and Audit R-4
  //     replaced withCarrierQuoteTimeout with the abort-capable variant after finding
  //     the old one abandoned the loser as a zombie retrying for minutes. Now exercises
  //     the pure decision table directly and requires the deadline to come from the
  //     bounded execution policy rather than an inline literal.
  // All six repaired assertions mutation-checked, mutation confirmed applied first.
  'test:rate-browser-carrier-account-click',
  'test:rate-browser-dynamic-service-selection',
  'test:rate-browser-manual-selection-table-sync',
  'test:rate-browser-manual-selection-apply-error',
  'test:ps-123-insured-rate-browser-display',
  'test:ps-390-rate-browser-country',
  'test:ps-135-rate-browser-rerank',
  'test:ps-295-rate-browser-speed-diagnostics',
  'test:ps-206-rate-browser-full-coverage',
  'test:ps-216-rate-browser-account-labels',
  'test:ps-403-rate-browser-provider-timeouts',
  // ── Batch 19: the inventory source-of-truth cluster ──
  //
  // Stock levels, the movement ledger, deduction atomicity, and the read models the
  // dashboard and InventoryView render. All of it money-adjacent (cost layers, COGS)
  // and none of it gating.
  //
  // ps-324-inventory-writepath was RED, and it is the SECOND guard in this sweep that
  // was asserting the LOOSER behavior -- it grouped receive/return with adjust as "free
  // directions, allowed either way". They are not free, and have not been since
  // INCREMENT_ONLY was added; the owner's own header states the rule as "ship / pick /
  // damage can only REMOVE stock; a manual `adjust` is a free correction and
  // receive/return add stock". The guard predates that set and never caught up.
  //
  // The strictness is right: a negative "receive" is a removal recorded as a receipt,
  // which corrupts what the movement TYPE means -- receive rows are what inbound
  // reports and cost layers read, so it would mint a negative cost layer. Note this
  // does NOT contradict PS-224 (negative stock is intentional = backorder): PS-224
  // governs the resulting stock LEVEL, this governs the SIGN OF A MOVEMENT RELATIVE TO
  // ITS TYPE. Repaired to mirror the decrement-only loop, mutation-checked three ways.
  'test:ps-439-inventory-sot',
  'test:ps-462-inventory-forward-rollback',
  'test:ps-462-inventory-preparation-rollout',
  'test:ps-462-inventory-correction-cutover',
  'test:inventory-source-of-truth',
  'test:inventory-reconciliation-dry-run',
  'test:ps-133-stock-math',
  'test:ps-052-sku-composition',
  'test:ps-247-inventory-deduct-atomic',
  'test:ps-247-inventory-route-scope',
  'test:ps-324-inventory-readmodel',
  'test:ps-324-inventory-writepath',
  'test:ps-325-sku-units',
  'test:ps-325-dashboard-inventory-snapshot',
  // PS-467/468 shipment attribution. Both tickets require this in the pack, for
  // the reason the tickets exist: a shipment that could not be attributed used
  // to be persisted with a bare NULL order_id and no signal, which is how a
  // dangerous-goods label became invisible to every order-scoped query. Six of
  // its twenty checks are CONSUMPTION pins -- an owner nothing calls is not a
  // fix, and shipment-sync losing those call sites must fail here.
  'test:ps-467-468-shipment-scope',
  // PS-467 audit: WHY each unattributed shipment is unattributed, derived not stored.
  // The card called 796 of them "recoverable" -- a dry-run proved the order_id is
  // recoverable in every case and correct in none, because those orders already have
  // the shipment. Pinned here because the precedence rule is what stops that mistake
  // recurring: sibling evidence must outrank the order number, or a duplicate reads as
  // a lost link and someone backfills 790 duplicate rows onto shipped orders.
  'test:ps-467-unattributed-audit',
  // PS-469: same facts => one run. The idempotency key used to include the
  // trigger's sourceEventId, which carries txid_current(), so every write minted
  // a new key and identical facts were re-evaluated forever -- 322,962 runs over
  // 294 orders in four days. Pinned here because the regression is silent: it
  // breaks nothing, it just burns the database.
  'test:ps-469-automation-idempotency',
  // PS-469 retention: the same table, bounded. The loop put 926 MB here in a week and
  // the fix stopped the growth, but nothing stopped the SIZE. Pinned for the half that
  // is easy to get wrong: automation_runs is the evidence ruleExecutionHistoryExists
  // reads, so pruning a row with matched_rule_version_ids would make a rule that really
  // ran silently deletable, audit trail and all. Those rows survive at any age.
  'test:ps-469-run-retention',
  // The three below were each found RED on a clean base on 2026-08-01, having
  // rotted unnoticed precisely because they were not in this pack. In every case
  // the protection was intact and only the source-text assertion had gone stale
  // (a literal moved into a helper, a condition wrapped onto a second line, a
  // helper renamed with -> try). A guard nobody runs is not a guard, so they are
  // pinned here now. Each was mutation-tested when repaired: break the thing it
  // protects and it goes red.
  // PS-431: worker_status_events is the telemetry that would have explained the
  // 2026-07-13 crash loop and could not, because its flag defaults off. Before that
  // flag can safely be flipped the log has to be bounded -- its emission rate is a
  // fixed 30s heartbeat, so it grows at a constant rate whether or not anything is
  // happening. Pinned here so the retention window cannot quietly become unbounded
  // and repeat what PS-469 hit at 925 MB.
  'test:ps-431-worker-status-event-retention',
  // PS-485: leadership acquisition is the gate on ALL THREE stately consumers
  // (orders, shipments, fulfillment-outbox). Failing to acquire used to retry
  // silently forever -- 29 minutes with no consumer, 40 minutes of dead order sync,
  // and a watchdog that queued recovery into the unconsumed queue and called it done.
  // Pinned for BOTH directions: a sustained failure must escalate to a restart, and
  // a brief one must NOT -- restarting during a normal deploy handoff would be worse
  // than the bug, since losing to the outgoing leader is exactly how handoff works.
  'test:ps-485-consumer-leadership-acquire',
  'test:ps-205-package-facts-precedence',
  'test:ps-361-shipment-sync-watchdog',
  'test:ps-409-status-catchup-backlog',
  // PS-470: an unsaved edit must never publish. publish() posts only the
  // simulation hash, so the backend ships the SAVED draft -- an operator
  // changed an action, published three times, and got three byte-identical
  // no-op versions, each reported as success.
  'test:ps-470-publish-gate-dirty',
  // PS-471: a periodic tick must never BLOCK on its advisory lock. One stranded
  // transaction held shipment_sync.watchdog.tick for 88 minutes; because the
  // watchdog blocked, every later tick queued behind it and pinned a Supavisor
  // connection, until no request could reach the database -- a ~90-minute
  // outage while Postgres itself sat idle. Pinned here because the guard cuts
  // BOTH ways: the periodic caller must skip, and the read-modify-write callers
  // (combo defaults, account-state, billing storage) must keep blocking, since
  // converting those the same way would silently drop writes.
  'test:ps-471-advisory-lock-safety',
  // PS-472: a blocked order must say WHY. A hazmat rule matched HU-10 HUGRAB
  // orders, the declaration write was refused by a capability flag, one failed
  // action failed the whole run, and a failed run blocks rating -- surfacing to
  // the operator as nothing but "Rate unavailable". 11 orders sat frozen for two
  // days while the cause sat in automation_action_results.reason the whole time.
  // Pinned here because half these checks are FAIL-CLOSED pins: DJ chose "hold
  // with a visible reason" over "skip and ship", so a later refactor must not
  // quietly turn an unrecordable hazmat declaration into a shippable order.
  'test:ps-472-automation-failure-visibility',
  // PS-473: the same lesson as PS-472, one layer down at the provider boundary.
  // A hazmat order was filtered to its one certified carrier and Stamps.com
  // returned a hard, non-retryable refusal -- which surfaced only as our own
  // fallthrough string "Carrier rate request failed", so "USPS declines
  // dangerous goods" and "our payload has a bad field" looked identical.
  // providerDetail carries the provider's real words. Pinned here for BOTH
  // halves: the detail must survive the field-by-field cache read-back, and
  // credentials must never ride along with it.
  'test:ps-473-provider-error-detail',
  // PS-474: an active hazmat declaration must not lose the ship-from phone.
  // Hazmat switches the request from /v2/rates/estimate (postal codes, no
  // addresses) to a full /v2/rates shipment -- so ship_from.phone is suddenly
  // required, and a Rate-Browser-supplied origin bypassed getDefaultShipFrom's
  // phone default. ShipStation answered 'phone should not be empty' and three
  // auto-declared HU-10 orders could not rate. Pinned because the guard covers
  // BOTH origin resolutions: the bug was one of them being un-normalised.
  'test:ps-474-hazmat-shipfrom-phone',
  // PS-475: the dangerous-goods mark follows the rules BOTH ways. Unticking
  // never worked -- no rule means no intent means no handler -- so orders kept
  // a HAZMAT badge with every rule paused. Pinned here because half the guard
  // is REFUSALS: a retraction must never touch a shipped order, never erase a
  // human's manual tick, never fire on unknown state, and hazmat.retract must
  // stay available:false so no rule can be authored to un-declare hazmat.
  'test:ps-475-hazmat-retraction',
  // PS-476: a rule status change must WAKE the orders it affects. PS-475 knew
  // how to retract but never ran -- pausing a rule enqueued nothing, and since
  // PS-469 killed the ambient re-evaluation loop, nothing else wakes an order.
  // Pinned for the two choices that silently break it: convergence must use
  // plain fact events (a paused rule can never be reprocessed) and must NOT use
  // the manual_reprocess trigger (which lets the add handler overwrite a human's
  // manual declaration), plus the cap that keeps PS-469 from recurring.
  'test:ps-476-rule-status-convergence',
  // PS-477: a shipment PrepShip did not purchase still discloses its hazmat.
  // Absence of a snapshot must never read as "not dangerous goods" -- the queue
  // omitted the fields entirely and the detail panel rendered clearDeclaration(),
  // so five shipped HUGRAB orders displayed as clear. Both entries are hermetic:
  // the first calls the pure reducer and reads source text, the second runs the
  // real loaders AND the real listQueue against in-process PGlite, overwriting
  // DATABASE_URL before the modules load so this runner's OFFLINE_GUARD_ENV
  // singleton is unreachable. Pinned as a pair because they fail in different
  // directions -- the reducer guard cannot see a caller that stops asking it,
  // and the integration guard is the only thing that runs the DTO builder the
  // bug actually lived in.
  'test:ps-477-hazmat-disclosure',
  'test:ps-477-hazmat-disclosure-integration',
  'test:ps-421-method-capability-matrix',
  'test:ps-314-no-sot-bypass-wrappers',
  'test:ps-316-backend-truth-law',
  'test:ps-336-task-sot-gates',
  'test:ps-426-awaiting-cursor-manual-sync',
  'test:ps-427-inventory-reconciliation',
  'test:ps-428-durable-worker-execution',
  'test:ps-429-final-review-closure',
  'test:ps-430-print-queue-worker-health',
  'test:ps-431-production-self-healing',
  'test:ps-432-sync-fulfillment-resilience',
  'test:ps-433-frontend-source-of-truth',
  'test:ps-441-sot-migration',
  'test:ps-436-sync-starvation',
  'test:ps-439-session-advisory-locks',
  'test:ps-450-inventory-outbox',
  'test:sync-continuous-self-healing',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-329-orders-wrapper-sot-cleanup',
  'test:ps-412-finalized-billing',
  'test:ps-449-billing-finalization',
  'test:audit-money-rounding',
  'test:audit-orders-service-boundary',
  'test:audit-pg-boss-inventory-outbox',
  'test:sync-job-admission',
  'test:audit-runtime-schema-readiness',
  'test:ps-455-runtime-schema-migration',
  'test:audit-imported-handler-boundary',
  'test:audit-print-queue-merge-durability',
  'test:audit-structured-money-logging',
  'test:audit-orders-bulk-snapshot',
  'test:audit-order-editable-write',
  'test:ps-451-order-editable-write',
  'test:audit-print-queue-lifecycle',
  'test:ps-452-print-queue-lifecycle',
  'test:audit-sync-watchdog-lifecycle',
  'test:audit-billing-cross-period-reconciliation',
  'test:audit-dead-code-cleanup',
  'test:audit-limiter-fingerprint-hygiene',
  'test:audit-sync-cursor-webhook-hygiene',
  'test:audit-frontend-cache-bundle-hygiene',
  'test:ps-458-query-cache-unification',
  'test:audit-billing-small-fixes',
  'test:audit-api-process-lifecycle',
  'test:audit-print-queue-small-fixes',
  'test:audit-backfill-diagnostics',
  'test:audit-rate-on-ingest',
  'test:audit-local-tariff-calibration',
  'test:audit-multi-instance-readiness',
  'test:audit-orders-raw-payload-policy',
  'test:audit-billing-close-workflow-ux',
  'test:audit-po-box-eligibility',
  'test:audit-table-virtualization',
];

const npmCli = process.env.npm_execpath;
const results = [];
// Enforce the pack's offline contract even when a developer shell has live DB credentials.
const OFFLINE_GUARD_ENV = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://sot_guard:offline@127.0.0.1:1/sot_guard',
  SUPABASE_URL: 'https://example.test',
  SUPABASE_ANON_KEY: 'offline',
  SUPABASE_SERVICE_ROLE_KEY: 'offline',
  SUPABASE_JWT_SECRET: 'offline',
};

for (const command of REQUIRED_GUARDS) {
  const startedAt = Date.now();
  console.log(`\n[sot-guard-pack] npm run ${command}`);
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, 'run', command], {
        stdio: 'inherit',
        shell: false,
        env: OFFLINE_GUARD_ENV,
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: OFFLINE_GUARD_ENV,
      });
  const durationMs = Date.now() - startedAt;
  results.push({
    command,
    status: result.status === 0 ? 'PASS' : 'FAIL',
    durationMs,
  });
  if (result.status !== 0) {
    console.table(results);
    console.error(`[sot-guard-pack] failed at ${command}`);
    process.exit(1);
  }
}

console.table(results);
console.log('[sot-guard-pack] passed');
