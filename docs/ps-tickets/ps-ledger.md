# PrepShip PS Ticket Ledger

This file prevents custom owner tasks and branch-only work from reusing PS numbers.

| PS | Title | Reference | Branch/Commit | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| PS-333 | HUGRAB current-rate source of truth | https://trello.com/c/F8jpCPbp | `origin/codex/ps-333-wrapper-sot-cleanup` | Final Review | Backend rate SOT cleanup. |
| PS-334 | House Rate column / customer Best Rate | https://trello.com/c/qoAI7EQn | `origin/codex/ps-334-house-rate-column-stable` | Final Review | House-rate display split. |
| PS-335 | SOT guard pack / Rate Browser single-flight | https://trello.com/c/QMAdKM9v | `origin/codex/ps-335-sot-guard-pack` | Final Review | Guard pack plus single-flight branch history. |
| PS-336 | Rate Browser loading cleanup | branch-only/current repo guard | `origin/codex/ps-336-rate-browser-loading-cleanup` | Landed/local only | Number already used; do not reuse. |
| PS-337 | Best Rate remove second line | branch-only | `origin/codex/ps-337-best-rate-remove-second-line` | Landed/local only | Number already used; eBay must move off this number. |
| PS-338 | Keep rates visible during browse refresh | branch-only | `origin/codex/ps-338-keep-rates-during-browse-refresh` | Landed/local only | Number already used unless read-only inventory says otherwise. |
| PS-339 | eBay API testing certification | https://trello.com/c/gRogisQ0 | planned renumber from `7c73663a` | Planned/local only | Proposed clean number for the custom eBay owner task; stop if read-only inventory proves PS-339 is already reserved. |
