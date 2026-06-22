# PS-285 Phase Checklist

PS-285 is an umbrella for PS-245 through PS-259. It must not be closed from a
single slice of evidence. This checklist is the status owner for the card until
the umbrella is split into smaller cards or each phase has its own source-of-
truth guard.

Current completion estimate: PS-285 35%.

Current recommendation: PS-285 is not Final Review-ready. Phase 8 is the only
fully complete phase, but a current evidence matrix now maps guard coverage
across PS-245 through PS-259 so the remaining phases can be finished or split
without duplicating tickets.

| # | Phase | Status | Evidence | Missing |
|---|---|---|---|---|
| 1 | Lockdown fence and protected-file audit | In progress | `test:ps-245-lockdown-fence`, `verify:lockdown-fence` | Attach current protected-file diff proof |
| 2 | Verification harness and baseline resolver | In progress | `test:ps-245-verification-harness`, `src/verification/verify-card.ts` | Golden/baseline operational capture remains separate |
| 3 | Auth and scope behavioral ratchets | In progress | `test:ps-246-*`, `test:ps-250-rates-scope-enforcement`, `test:ps-252-catalog-mutation-authz`, `test:authz-guard-behavioral-ratchet` | Remaining auth/scope guard conversions still tracked |
| 4 | Label purchase boundary safety | In progress | `test:ps-248-label-purchase-lock`, `test:ps-248-persist-mark-shipped-atomic` | Produce one consolidated PS-285 evidence packet |
| 5 | Print queue durability and idempotency | In progress | `test:ps-253-outbox-stale-reclaim`, `test:ps-256-durable-print-queue-pdf` | Prove no duplicate label/queue regression across current code |
| 6 | Shipped/cancelled lockdown preservation | In progress | `test:ps-245-lockdown-fence`, `test:ps-258-component-boundary` | Keep locked runtime behavior untouched without override |
| 7 | Void/retract and cancellation safety | In progress | `test:ps-253-combo-confirm-atomicity`, `test:ps-263-void-confirmation-retract` | Attach focused void/retract run in the PS-285 packet |
| 8 | Marketplace confirmation boundary | Complete | test:ps-285-marketplace-confirm-boundary | None for this phase |
| 9 | Recovery/retry tooling safety | In progress | `test:ps-255-ops-confirm-gate`, `test:ps-256-durable-worker-status` | Split remaining live retry/canary tails or keep explicitly out of PS-285 closeout |
| 10 | Observability and runbook coverage | In progress | `docs/security-readiness-checklist.md`, `docs/shipping-certification-harness.md` | Add PS-285-specific runbook evidence before review |
| 11 | End-to-end certification matrix | In progress | `docs/full-workflow-certification-matrix.md`, `scripts/run-workflow-certification.mjs` | Run the mapped safe suite and summarize failures |
| 12 | Final umbrella closeout packet | In progress | This checklist, `docs/ps-tickets/ps-285-phase-evidence-matrix.md`, `test:ps-285-umbrella-closeout` | Complete every phase or split unfinished phases into separate cards |

Safety: No live marketplace notifications, no postage, no real label purchase,
no production queue mutation, and no shipped/cancelled data mutation are part of
this audit artifact.
