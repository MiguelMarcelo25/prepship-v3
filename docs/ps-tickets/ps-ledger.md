# PrepShip PS Ticket Ledger

This file prevents custom owner tasks and branch-only work from reusing PS numbers.

| PS | Title | Reference | Branch/Commit | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| PS-331 | PrepShip dead-code inventory + safe deletion plan | Trello To Do (connector unavailable) | `codex/ps-ticket-hygiene-bridge-cleanup` | Blocked/local artifact only | Inventory and deletion gates only; no deletion performed. |
| PS-333 | HUGRAB current-rate source of truth | https://trello.com/c/F8jpCPbp | `origin/codex/ps-333-wrapper-sot-cleanup` | Final Review | Backend rate SOT cleanup. |
| PS-334 | House Rate column / customer Best Rate | https://trello.com/c/qoAI7EQn | `origin/codex/ps-334-house-rate-column-stable` | Final Review | House-rate display split. |
| PS-335 | SOT guard pack / Rate Browser single-flight | https://trello.com/c/QMAdKM9v | `origin/codex/ps-335-sot-guard-pack` | Final Review | Guard pack plus single-flight branch history. |
| PS-336 | Rate Browser loading cleanup | branch-only/current repo guard | `origin/codex/ps-336-rate-browser-loading-cleanup` | Landed/local only | Number already used; do not reuse. |
| PS-337 | Best Rate remove second line | branch-only | `origin/codex/ps-337-best-rate-remove-second-line` | Landed/local only | Number already used; eBay must move off this number. |
| PS-338 | Keep rates visible during browse refresh | branch-only | `origin/codex/ps-338-keep-rates-during-browse-refresh` | Landed/local only | Number already used unless read-only inventory says otherwise. |
| PS-339 | eBay API testing certification | https://trello.com/c/gRogisQ0 | planned renumber from `7c73663a` | Planned/local only | Proposed clean number for the custom eBay owner task; stop if read-only inventory proves PS-339 is already reserved. |
| PS-340 | Backend rate engine | local cleanup / backend guard | `prepshipv4-stable` | Landed/local only | Guards backend-owned bounded rate fan-out, single-flight browse, and volume proof. |
| PS-341 | Frontend compatibility helper audit | local cleanup | `codex/ps-ticket-hygiene-bridge-cleanup` | Landed/local only | Removed saved Best Rate multi-shape proof helper fallback. |
| PS-342 | Legacy rate display adapter cleanup | local cleanup | `codex/ps-ticket-hygiene-bridge-cleanup` | Landed/local only | Removes frontend provider-money reconstruction from the legacy rate array adapter. |
| PS-343 | RateBrowserModal money normalization cleanup | local cleanup | `codex/ps-ticket-hygiene-bridge-cleanup` | Landed/local only | Removes Rate Browser frontend provider-money reconstruction; backend stamps rate-cost/customer aliases. |
| PS-344 | Order row workflow shape cleanup | local cleanup | `codex/ps-ticket-hygiene-bridge-cleanup` | Landed/local only | Removes nested shippingModel bestRateWorkflow fallback from frontend action reader. |
| PS-345 | Rate loading orchestration source-of-truth cleanup | https://trello.com/c/a80Wp1w3 | `codex/ps-345-rate-loading-sot` | In progress | Removes passive frontend live-rate orchestration; backend/manual intent owns live rate work. |
| PS-346 | Rate/order slow paths and partial Rate Browser results | https://trello.com/c/CcZRrJsH | `codex/ps-346-slow-paths-plan` | In progress | Plans backend-owned partial rate workflow, Orders refresh dedupe, and high-volume queue evidence. |
| PS-352 | Architecture-first shipping workflow SOT map + wrapper deletion plan | https://trello.com/c/9IjFnCDa | `prepshipv4-stable` | In progress | Names canonical owners, wrapper delegation/deletion targets, and PS-349/350/351/353/355/331 cutover order. |
