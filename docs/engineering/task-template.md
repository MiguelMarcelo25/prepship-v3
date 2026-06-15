# PrepShip Developer Task Template

Reusable template for a non-trivial PrepShip V4 task. Copy it into the ticket/PR. It
bakes in the Architecture-First standard ([../../ARCHITECTURE.md](../../ARCHITECTURE.md))
so work routes to the canonical owner instead of the nearest symptom.

---

**Task ID / title:**
**Assignee:**
**Repo / branch:**

## Context

<!-- The problem, the observed symptom, and any concrete reproduction (sanitized — no
PII, tokens, or raw provider payloads). -->

## Files / docs to inspect first

<!-- Where the relevant truth likely lives: services, policies, adapters, routes, DTOs,
existing guards/tests. -->

## Architecture placement

> Fix the source of truth, not the symptom. Trace bad data to where it first entered.

- **Business rule / workflow changing:**
- **Where imperfect data may enter** (earliest point bad/stale/incomplete/ambiguous data
  can enter — sync/webhook, import, provider payload, default/fallback, cache write, input):
- **Canonical owner / source of truth** (file + symbol):
- **Why this layer** (and why not the UI/route/adapter):
- **Callers to update to delegate:**
- **Duplicate logic to remove** (or leave as follow-up debt):
- **Boundary tests required** (at the owner):
- **Workflow / UI / API tests required** (when applicable, for the operator-visible symptom):

## Implementation requirements

<!-- The concrete changes, in terms of the owner first, then thin consumers. -->

## Guardrails / forbidden changes

- No secrets / PII / raw payloads / raw label URLs in code, tests, logs, or notes.
- No real postage, labels, voids, or live marketplace notifications in tests.
- No production shipped/cancelled or shipment-history mutation without the AGENTS.md
  `unlock shipped data` override.
- Do not weaken auth/RBAC, client/store scope, selected-rate proof, secret redaction,
  label safety, or billing/inventory correctness.
- Keep routes thin and the frontend a consumer; no business-critical decision in UI.

## Verification commands

```
npm run typecheck
# focused guards for the canonical owner
# build:web / browser / workflow checks if UI or workflow is touched
```

## Definition of done

- Change lives at the canonical owner; callers delegate; routes/UI/adapters stay thin.
- Boundary test at the owner passes; operator-symptom test passes.
- Duplicate logic removed or recorded as follow-up debt.
- Verification commands run with pass/fail evidence; no safety boundary weakened.

## Return format

- Summary of what changed and the canonical owner it landed on.
- Files changed.
- Behavior before / after.
- Commands run with pass/fail results.
- Risks / known follow-ups.
- Confirmation no real postage/labels/marketplace notifications/shipped mutations occurred.
