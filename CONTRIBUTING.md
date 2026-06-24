# Contributing to PrepShip V4

Before any non-trivial change, read **[ARCHITECTURE.md](ARCHITECTURE.md)** — the
Architecture-First Development Standard. The short version: fix the bug where the truth
should live (the canonical owner), make callers delegate, add a boundary test, then
adjust UI/adapters as thin consumers. Don't patch the nearest symptom if the business
rule belongs deeper.

AI coding agents must also follow [AGENTS.md](AGENTS.md) (mirrored to `CLAUDE.md` and
`.cursorrules`), including the shipped/cancelled lockdown.

## What every non-trivial PR must include

1. **Architecture placement notes** (see [ARCHITECTURE.md](ARCHITECTURE.md) and the
   [PR template](.github/pull_request_template.md)):
   - the business rule/workflow changed,
   - **where bad, stale, incomplete, ambiguous, or less-than-perfect data could first have
     entered** the workflow, and why the fix moves the rule to the canonical owner rather
     than patching the symptom,
   - the canonical owner / source of truth (file + symbol) and why that layer,
   - which callers were updated to delegate,
   - duplicate logic removed or explicitly left as follow-up debt.
2. **Boundary / source-of-truth tests** at the canonical owner — not only a UI snapshot.
   Add a workflow/API/browser test for the operator-visible symptom too.
3. **Evidence:** the exact commands you ran with pass/fail results
   (`npm run typecheck`, the relevant guards, `npm run build:web`, browser/workflow
   checks where applicable). State plainly if something was skipped or failed.
4. **No source-of-truth bypass wrappers.** A wrapper/helper/adapter may translate provider
   shapes, normalize formatting, or forward to the canonical owner — but it must never own a
   business rule, choose an authoritative value, compute money/rate/eligibility/inventory/
   billing truth, rank "best" options, persist authoritative state, or silently fall back to
   stale/alternate truth. If a wrapper needs business logic, move the rule to the
   source-of-truth owner and make the wrapper delegate (see
   [ARCHITECTURE.md](ARCHITECTURE.md) → *No Source-of-Truth Bypass Wrappers*).

## Safety rules (do not weaken)

- Never expose secrets, tokens, credentials, customer PII, raw provider payloads, full
  tracking numbers, customer addresses, or raw label URLs in code, tests, logs,
  screenshots, or PR notes.
- Do not buy postage, create/void real labels, or send live marketplace notifications in
  automated tests — use mocked/offline/sandbox fixtures.
- Do not mutate production shipped/cancelled orders or shipment history. The
  shipped/cancelled lockdown in [AGENTS.md](AGENTS.md) requires the explicit
  `unlock shipped data` override.
- Keep routes thin and the frontend a consumer: no money/label/inventory/fulfillment/
  auth/rate/marketplace **decision** may move into the UI or an adapter.
- Preserve auth/RBAC, client/store scope, selected-rate proof/fingerprint enforcement,
  secret redaction, and billing/inventory correctness.

## Workflow conventions

- TypeScript strict mode — all new code must pass `npm run typecheck`.
- Tailwind-first styling with theme-aware tokens (`bg-surface`, `text-ink`, `ring-line`,
  `bg-brand`, …); avoid hardcoded hex in component styles.
- When the user says "do not push" or "review first", commit locally only.
- Every bug fix adds or updates a regression guard (it should fail before the fix and
  pass after); wire it into `package.json` and the master test manifest where relevant
  (see [docs/testing/master-regression-suite.md](docs/testing/master-regression-suite.md)).
