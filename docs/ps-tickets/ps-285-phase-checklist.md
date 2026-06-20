# PS-285 Phase Checklist

PS-285 is an umbrella for PS-245 through PS-259. It must not be closed from a
single slice of evidence. This checklist is the status owner for the card until
the umbrella is split into smaller cards or each phase has its own source-of-
truth guard.

Current recommendation: PS-285 is not Final Review-ready. Only phase 8 is proven
by focused guard evidence in this slice.

| # | Phase | Status | Evidence | Missing |
|---|---|---|---|---|
| 1 | Lockdown fence and protected-file audit | In progress | PS-245 guard family exists | Attach fresh full guard run and current protected-file diff proof |
| 2 | Verification harness and baseline resolver | In progress | PS-245 verification harness exists | Confirm every umbrella child has resolver wiring |
| 3 | Auth and scope behavioral ratchets | In progress | PS-259 behavioral ratchet files exist | Run full auth/scope guard bundle and summarize failures |
| 4 | Label purchase boundary safety | In progress | Purchase proof guards exist across PS-094/098/105/202 | Produce one consolidated PS-285 evidence packet |
| 5 | Print queue durability and idempotency | In progress | Print queue guards exist | Prove no duplicate label/queue regression across current code |
| 6 | Shipped/cancelled lockdown preservation | In progress | AGENTS lockdown plus specific guards | Re-run lockdown fence against current branch |
| 7 | Void/retract and cancellation safety | In progress | PS-263 related outbox protections referenced | Attach focused guard evidence |
| 8 | Marketplace confirmation boundary | Complete | test:ps-285-marketplace-confirm-boundary | None for this phase |
| 9 | Recovery/retry tooling safety | Not started | Retry/repair scripts exist | Add focused offline guard or split into a card |
| 10 | Observability and runbook coverage | Not started | Existing runbooks/ops docs | Connect PS-285-specific runbook evidence |
| 11 | End-to-end certification matrix | Not started | General certification docs exist | Map each child ticket to required guard/canary |
| 12 | Final umbrella closeout packet | Not started | This checklist | Run every phase guard and prepare Trello closeout report |

Safety: No live marketplace notifications, no postage, no real label purchase,
no production queue mutation, and no shipped/cancelled data mutation are part of
this audit artifact.
