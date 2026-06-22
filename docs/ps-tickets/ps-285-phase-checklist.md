# PS-285 Phase Checklist

PS-285 is an umbrella for PS-245 through PS-259. It must not be closed from a
single slice of evidence. This checklist is the status owner for the card until
the umbrella is split into smaller cards or each phase has its own source-of-
truth guard.

Current completion estimate: PS-285 75%.

Current recommendation: PS-285 is not Final Review-ready. Phases 1, 3, 4, 5,
7, 8, 9, 10, and 11 are complete, but the remaining phases still include
verification harness operational capture, lockdown preservation, and final
closeout work. A current evidence matrix maps guard coverage across PS-245 through PS-259 so the
remaining phases can be finished or split without duplicating tickets.

| # | Phase | Status | Evidence | Missing |
|---|---|---|---|---|
| 1 | Lockdown fence and protected-file audit | Complete | `test:ps-245-lockdown-fence`, `verify:lockdown-fence`, `docs/ps-tickets/ps-285-protected-file-diff-proof.md`, `test:ps-285-protected-file-diff-proof` | None for this phase |
| 2 | Verification harness and baseline resolver | In progress | `test:ps-245-verification-harness`, `src/verification/verify-card.ts` | Golden/baseline operational capture remains separate |
| 3 | Auth and scope behavioral ratchets | Complete | `test:ps-246-*`, `test:ps-250-rates-scope-enforcement`, `test:ps-252-catalog-mutation-authz`, `test:authz-guard-behavioral-ratchet`, `docs/ps-tickets/ps-285-auth-scope-evidence.md`, `test:ps-285-auth-scope-evidence` | None for this phase |
| 4 | Label purchase boundary safety | Complete | `test:ps-248-label-purchase-lock`, `test:ps-248-persist-mark-shipped-atomic`, `docs/ps-tickets/ps-285-label-purchase-evidence.md`, `test:ps-285-label-purchase-evidence` | None for this phase |
| 5 | Print queue durability and idempotency | Complete | `test:ps-253-outbox-stale-reclaim`, `test:ps-256-durable-print-queue-pdf`, `test:ps-053-print-queue-atomic`, `test:ps-303-print-queue-authority`, `docs/ps-tickets/ps-285-print-queue-evidence.md`, `test:ps-285-print-queue-evidence` | None for this phase |
| 6 | Shipped/cancelled lockdown preservation | In progress | `test:ps-245-lockdown-fence`, `test:ps-258-component-boundary` | Keep locked runtime behavior untouched without override |
| 7 | Void/retract and cancellation safety | Complete | `test:ps-253-combo-confirm-atomicity`, `test:ps-263-void-confirmation-retract`, `test:ps-211-universal-void`, `test:ps-129-upstream-cancellation-hold`, `docs/ps-tickets/ps-285-void-retract-evidence.md`, `test:ps-285-void-retract-evidence` | None for this phase |
| 8 | Marketplace confirmation boundary | Complete | test:ps-285-marketplace-confirm-boundary | None for this phase |
| 9 | Recovery/retry tooling safety | Complete | `test:ps-255-ops-confirm-gate`, `test:ps-256-durable-worker-status`, `test:ps-256-durable-rate-limiter`, `test:ps-288-label-recovery`, `docs/ps-tickets/ps-285-recovery-retry-evidence.md`, `test:ps-285-recovery-retry-evidence` | None for this offline/static phase |
| 10 | Observability and runbook coverage | Complete | `docs/security-readiness-checklist.md`, `docs/shipping-certification-harness.md`, `docs/ps-tickets/ps-285-runbook-evidence.md`, `test:ps-285-runbook-evidence` | None for this phase |
| 11 | End-to-end certification matrix | Complete | `docs/full-workflow-certification-matrix.md`, `scripts/run-workflow-certification.mjs`, `docs/ps-tickets/ps-285-workflow-certification-evidence.md`, `test:workflow-suites`, `test:ps-285-workflow-certification-evidence` | None for this offline/static phase |
| 12 | Final umbrella closeout packet | In progress | This checklist, `docs/ps-tickets/ps-285-phase-evidence-matrix.md`, `test:ps-285-umbrella-closeout` | Complete every phase or split unfinished phases into separate cards |

Safety: No live marketplace notifications, no postage, no real label purchase,
no production queue mutation, and no shipped/cancelled data mutation are part of
this audit artifact.
