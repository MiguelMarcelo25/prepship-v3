# PS-336 - Task SOT Gates

## Scope

PS-336 makes backend source-of-truth placement unavoidable in future PrepShip task and PR
workflows. Repo instruction docs and task templates are the source of truth for this workflow;
the consolidated SOT guard pack is the enforcement layer.

## PS-336 Number Collision

The repo already has `test:ps-336-rate-browser-loading-cleanup` for an older local Rate
Browser loading cleanup guard. This Trello PS-336 is tracked separately as
`test:ps-336-task-sot-gates` and this document. The older guard is preserved.

## What Changed

- `docs/engineering/task-template.md` now requires an Architecture placement / source-of-truth
  gate with canonical owner, unsafe owners, bad-data entry point, callers, wrapper logic,
  frontend role, backend boundary tests, and workflow/UI proof.
- Agent/developer docs state that if a task does not name the canonical owner, the developer
  must return a placement mismatch note before coding.
- The PR template and architecture checklist require duplicated/unsafe owner and wrapper
  deletion/forbid fields.
- `test:ps-336-task-sot-gates` is wired into `test:sot-guard-pack` and the PS-335 guard-of-guard.

## Allowed And Forbidden Wrappers

Allowed wrappers translate provider payloads, normalize units/dates/names, preserve temporary
compatibility, or delegate directly to the canonical owner.

Forbidden wrappers choose Best Rate, calculate margin/customer rate, decide inventory or billing
truth, save authoritative state, silently fall back to stale/cached/alternate truth, or bypass
the canonical owner.

## Safety

No product behavior changed. No live labels, postage, marketplace notifications, inventory,
billing, production data, shipped/cancelled rows, provider credentials, or customer data changed.

## Proof

Run:

```bash
npm run test:ps-336-task-sot-gates
npm run test:ps-314-no-sot-bypass-wrappers
npm run test:ps-316-backend-truth-law
npm run test:ps-335-sot-guard-pack
npm run test:sot-guard-pack
npm run typecheck
npm run build:web
```
