# PS-285 phase evidence matrix

Date: 2026-06-22

## Status

Current completion estimate: PS-285 50%.

PS-285 is not Final Review-ready. The current repo has meaningful child-ticket
guard coverage across PS-245 through PS-259, but PS-285 remains an umbrella:
coverage and ratchets are not the same as finishing every production gap. This
matrix prevents duplicate cards and prevents one child slice from closing the
whole umbrella.

## Child ticket guard map

| Child | Guard coverage |
|---|---|
| PS-245 | `test:ps-245-lockdown-fence`, `test:ps-245-verification-harness` |
| PS-246 | `test:ps-246-financials-write-permission`, `test:ps-246-behavioral-rls-matrix`, `test:ps-246-jwt-audit-soak` |
| PS-247 | `test:ps-247-inventory-deduct-atomic`, `test:ps-247-inventory-route-scope` |
| PS-248 | `test:ps-248-label-purchase-lock`, `test:ps-248-persist-mark-shipped-atomic` |
| PS-249 | `test:ps-249-billing-write-permission`, `test:ps-249-storage-atomicity`, `test:ps-249-billing-details-transaction` |
| PS-250 | `test:ps-250-rates-scope-enforcement` |
| PS-251 | `test:ps-251-ssrf-allowlist`, `test:ps-251-fetch-timeout` |
| PS-252 | `test:ps-252-catalog-mutation-authz` |
| PS-253 | `test:ps-253-automation-rule-lock`, `test:ps-253-outbox-stale-reclaim`, `test:ps-253-combo-confirm-atomicity` |
| PS-254 | `test:ps-254-perimeter-hardening`, `test:ps-254-secret-scan` |
| PS-255 | `test:ps-255-ops-confirm-gate` |
| PS-256 | `test:ps-256-durable-rate-limiter`, `test:ps-256-durable-worker-status`, `test:ps-256-durable-print-queue-pdf` |
| PS-257 | `test:ts-nocheck-ratchet` |
| PS-258 | `test:ps-258-component-boundary`, `test:ps-258-daily-stats-rollover`, `test:ps-258-empty-panel-contract`, `test:ps-258-empty-state-props-contract`, `test:ps-258-non-critical-scheduler`, `test:ps-258-orders-column-prefs-local`, `test:ps-258-orders-filtered-sort`, `test:ps-258-orders-queue-parsers`, `test:ps-258-orders-table-density-prefs`, `test:ps-258-search-bar-contract`, `test:ps-166-ps-258-decomposition-certification` |
| PS-259 | `test:authz-guard-behavioral-ratchet` |

## Phase status

| # | Phase | Status | Evidence | Missing |
|---|---|---|---|---|
| 1 | Lockdown fence and protected-file audit | Complete | `test:ps-245-lockdown-fence`, `verify:lockdown-fence`, `docs/ps-tickets/ps-285-protected-file-diff-proof.md`, `test:ps-285-protected-file-diff-proof` | None for this phase |
| 2 | Verification harness and baseline resolver | In progress | `test:ps-245-verification-harness`, `src/verification/verify-card.ts` | Golden/baseline operational capture remains separate |
| 3 | Auth and scope behavioral ratchets | In progress | `test:ps-246-*`, `test:ps-250-rates-scope-enforcement`, `test:ps-252-catalog-mutation-authz`, `test:authz-guard-behavioral-ratchet` | Remaining auth/scope guards need full behavioral conversion where still ratcheted |
| 4 | Label purchase boundary safety | Complete | `test:ps-248-label-purchase-lock`, `test:ps-248-persist-mark-shipped-atomic`, `docs/ps-tickets/ps-285-label-purchase-evidence.md`, `test:ps-285-label-purchase-evidence` | None for this phase |
| 5 | Print queue durability and idempotency | In progress | `test:ps-253-outbox-stale-reclaim`, `test:ps-256-durable-print-queue-pdf` | Cross-path duplicate label/queue regression packet still needed |
| 6 | Shipped/cancelled lockdown preservation | In progress | `test:ps-245-lockdown-fence`, `test:ps-258-component-boundary` | Cannot touch locked runtime behavior without the required override |
| 7 | Void/retract and cancellation safety | In progress | `test:ps-253-combo-confirm-atomicity`, `test:ps-263-void-confirmation-retract` | Attach focused void/retract run in the PS-285 packet |
| 8 | Marketplace confirmation boundary | Complete | `test:ps-285-marketplace-confirm-boundary` | None for this phase |
| 9 | Recovery/retry tooling safety | In progress | `test:ps-255-ops-confirm-gate`, `test:ps-256-durable-worker-status` | Split remaining live retry/canary tails or keep explicitly out of PS-285 closeout |
| 10 | Observability and runbook coverage | Complete | `docs/security-readiness-checklist.md`, `docs/shipping-certification-harness.md`, `docs/ps-tickets/ps-285-runbook-evidence.md`, `test:ps-285-runbook-evidence` | None for this phase |
| 11 | End-to-end certification matrix | In progress | `docs/full-workflow-certification-matrix.md`, `scripts/run-workflow-certification.mjs` | Run the mapped safe suite and summarize failures |
| 12 | Final umbrella closeout packet | In progress | `docs/ps-tickets/ps-285-phase-checklist.md`, this matrix, `test:ps-285-umbrella-closeout` | Complete every phase or split unfinished phases into separate cards |

## Safety

This matrix is offline/static. It does not run live labels, buy postage, print
labels, send marketplace notifications, mutate production orders, mutate production queues, or
modify shipped/cancelled data.

No Trello comment, card move, card creation, or card edit is authorized by this
document.
