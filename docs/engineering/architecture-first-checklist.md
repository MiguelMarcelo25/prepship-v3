# Architecture-First Checklist

A practical companion to [../../ARCHITECTURE.md](../../ARCHITECTURE.md). Use it before
coding and during review so changes land at the canonical source of truth, not the
nearest symptom.

## Pre-coding questions (answer before writing code)

1. **What business decision or invariant is changing?** (one sentence)
2. **Where can imperfect data first enter this workflow?** Name the earliest point where
   bad, stale, incomplete, ambiguous, or less-than-perfect data can enter (sync/webhook,
   import, provider payload, default/fallback, cache write, input boundary).
3. **Where does this behavior currently live?** Find the canonical owner.
4. **Is it duplicated** across UI / routes / adapters / services?
4. **What is the canonical owner after this change?** (file + symbol)
5. **Which callers should delegate** to that owner instead of re-deriving the fact?
6. **What duplicate logic can be removed** — or explicitly left as follow-up debt?
7. **Which boundary test proves the rule at the canonical owner?**
8. **Which workflow / browser / API test proves the operator symptom is fixed?**

If you cannot name the canonical owner, stop and find it before coding.

## PR review checklist

- [ ] The **SOT/no-wrapper guard pack** passed for any source-of-truth-sensitive
      change: `npm run test:sot-guard-pack`.
- [ ] The PR names the **bad-data injection point** — where imperfect data first entered.
- [ ] The fix is at the **canonical owner**, not the visible symptom.
- [ ] UI / routes / adapters are **thin consumers** after the change.
- [ ] Tests are at the **source-of-truth boundary**, not only at the UI symptom.
- [ ] The change is at the canonical owner; the symptom site is a thin consumer.
- [ ] Routes stay thin (validate → call service → return DTO); no business logic added.
- [ ] Adapters/connectors only translate provider data; no cross-workflow policy.
- [ ] The frontend owns no money/label/inventory/fulfillment/auth/rate/marketplace
      decision and mints no proof.
- [ ] A boundary/source-of-truth test exists at the owner (not only a UI snapshot).
- [ ] Duplicate logic is removed or recorded as explicit follow-up debt.
- [ ] Safety boundaries intact (auth/scope, proof, redaction, billing/inventory,
      shipped/cancelled lockdown).
- [ ] Commands run are reported with pass/fail evidence.

## Fast rejection signals (send it back)

- The PR fixes where bad data *surfaces* but never identifies where it first *entered*.
- The PR only changes the visible symptom and does not explain why the canonical source of
  truth is already correct, or how the fix moved the rule to that source of truth.
- A frontend-only diff changes money, rates, labels, inventory, marketplace confirmation,
  billing, or auth/scope (backend-owned truth) without a backend owner change.
- The diff only touches a UI component/helper but the bug is a business-rule bug.
- The frontend computes a total, picks the "best" option, or builds a proof.
- An adapter decides eligibility/insurance/winner instead of the policy/workflow service.
- The same mapping now exists in two layers that can disagree.
- A new "fallback" path becomes a second source of truth.
- A failing boundary test was "fixed" by moving the assertion into the UI.
- No boundary test; only a snapshot that would pass even if the rule were wrong.
