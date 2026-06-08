# Architecture-First Development Standard

This is how PrepShip V4 changes are made. It exists to stop the pattern that has
repeatedly produced spaghetti: a bug appears in the UI, someone patches the nearest
component or helper, the real business rule stays scattered, and the same class of bug
returns somewhere else. Read this before any non-trivial change.

## The core rule

> **Do not fix only where the bug appears.**
> **Find where the truth should live.**
> **Fix it there.**
> **Make callers use that truth.**
> **Add tests at that boundary.**
> **Then adjust UI/adapters as thin consumers.**

A symptom in the frontend is rarely a frontend bug. Ask "what business fact is wrong, and
which layer *owns* that fact?" Fix the owner; let everything else consume it.

### A worked example (PS-108)

The Rate Browser displayed a postage-only total ($6.67) for an insured HUGRAB order that
actually billed $7.76. The symptom was in the UI total. The *truth* — the ParcelGuard
premium on a rate — belongs at the **rate-fetch boundary**, not in a display helper. The
fix populated the authoritative premium once at that boundary; `pickBestRate`, the cache,
the selected-rate proof, and the dedupe key (all already insurance-aware) started telling
the truth for free, and the UI became a thin consumer. Patching the display total would
have left best-rate *selection* still wrong.

## Canonical layer ownership

Every behavior has exactly one canonical owner. Find it before you code.

| Layer | Owns | Must NOT own |
|---|---|---|
| **Domain / workflow services** (`src/services/**`) | Business decisions, orchestration, invariants, source-of-truth state (rates, labels, fulfillment, inventory, billing). | Transport/presentation concerns. |
| **Policy services** (eligibility, scope, proof) | Allow/deny decisions, eligibility rules, what-is-permitted. | Provider payload shapes. |
| **Adapters / connectors** (`src/connectors/**`, `src/lib/<provider>/**`) | Translating a provider's API into normalized internal shapes. | Cross-workflow business policy (e.g. which rate wins, whether to insure). |
| **API routes / controllers** (`src/routes/**`) | Input validation, auth/scope enforcement, calling services, returning DTOs. Stay **thin**. | Business logic, money math, proof minting. |
| **Frontend / UI** (`web/**`) | Rendering backend state, capturing operator intent, local form state, presentation formatting, optimistic spinners. | Money/label/inventory/fulfillment/auth/rate/marketplace **decisions** or minting proofs. |
| **Read models / DTOs** (`src/services/*-dto.ts`) | Deriving display state from authoritative service outputs. | Becoming an alternate source of truth. |

**Frontend must not own backend-critical decisions** for rates, labels, inventory,
fulfillment, billing, auth/scope, marketplace notifications, or shipped/cancelled locks.
If the UI computes an authoritative value from fallback fields, that is a source-of-truth
risk unless the backend explicitly marked it presentation-only.

## Decision tree — where does this code belong?

1. **What business decision or invariant is changing?** Name it in one sentence.
2. **Where does that fact live today?** Search for the canonical owner. Is it duplicated
   across UI / routes / adapters / services?
3. **Is the right owner deeper than where the bug showed up?**
   - Yes → place the change at the canonical owner; make the symptom site a thin consumer.
   - No (it is genuinely presentation/transport) → fix it at that layer and say why.
4. **Which callers should now delegate** to the owner instead of re-deriving the fact?
5. **What duplicate logic can be removed** (or marked as explicit follow-up debt)?
6. **Which boundary test pins the rule at the owner?** Add it there, not only at the UI.

## Anti-patterns to reject

- ✗ Patching the nearest UI component/helper when the rule belongs in a service.
- ✗ Frontend computing money, choosing the final/best rate, or minting a proof.
- ✗ Adapters deciding cross-workflow policy (eligibility, insurance, winner selection).
- ✗ Fat routes with business logic instead of thin validate→call-service→return-DTO.
- ✗ Duplicating the same mapping in two layers so they can silently disagree.
- ✗ A second "fallback" source of truth that can diverge from the canonical one.
- ✗ Showing a provisional value (e.g. "best so far") as if it were final/complete.
- ✗ "Fixing" a failing boundary test by moving the assertion to the UI.

## Required architecture placement note (non-trivial PRs)

Every non-trivial PR states:

- **Business rule / workflow changed:** …
- **Canonical owner / source of truth:** file + symbol.
- **Why this layer:** …
- **Callers updated to delegate:** …
- **Duplicate logic removed** (or explicitly left as follow-up debt): …
- **Boundary tests added** at the owner: …

## Definition of done

- The change lives at the canonical owner; callers delegate to it.
- Routes/adapters/UI stay thin consumers; no business-critical decision moved into them.
- A boundary/source-of-truth test proves the rule at the owner, and a
  workflow/API/browser test proves the operator-visible symptom is fixed.
- Duplicate logic is removed or recorded as follow-up debt.
- `npm run typecheck` passes; commands run are reported with pass/fail evidence.

## Safety boundaries (never weakened by an architecture change)

Auth/RBAC, client/store scope, selected-rate proof/fingerprint enforcement,
source-of-truth constraints, label/postage safety, marketplace-notification safety,
billing correctness, inventory-ledger correctness, secret redaction, and the
**shipped/cancelled lockdown** in [AGENTS.md](AGENTS.md) all stand regardless of how an
architecture refactor is framed. When in doubt, stop and ask.
