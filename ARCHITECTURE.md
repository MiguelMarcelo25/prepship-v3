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

## Backend-Owned Truth Without Backend Monoliths

**Backend owns decisions. Frontend owns interaction. Workers own slow provider work.
Read models own fast display. Final guards own money safety.**

"The backend owns the truth" does NOT mean one API request does all the work synchronously.
Backend ownership means the backend is the *authoritative source* for every business decision —
not that a single page load should fetch every provider live. Overloading one route is how a
source-of-truth win turns back into a slow, fragile monolith.

**Bad — the synchronous god-request:**

```
/orders page loads
→ backend fetches orders
→ also calls Walmart
→ also calls ShipStation
→ also recalculates rates
→ also checks inventory
→ also computes billing
→ response becomes slow and fragile
```

**Good — fresh state, thin reads, async heavy work, final re-validation:**

```
webhooks / sync workers / background jobs keep canonical backend state fresh
→ backend stores operational truth and read models
→ frontend fetches fast DTOs
→ expensive checks run asynchronously or on demand
→ final mutation boundaries re-validate before money/safety side effects
```

### Frontend owns (interaction & presentation)

- layout, tables, filters / search / sort UI state
- column visibility/widths, modal/drawer open state
- form draft values before save
- safe optimistic UI where the backend can roll back
- visual badges/colors, local display formatting, non-authoritative previews

### Frontend must not own (authoritative decisions)

The frontend may *display* backend-provided state for these, but the backend must *enforce* them:

- rate selection / Best Rate truth; selected-rate proof / rate freshness
- label/postage purchase eligibility; shipping provider endpoint routing
- carrier / account / service eligibility
- shipped / cancelled / source-shipped safety locks
- marketplace / source confirmation truth; duplicate-shipment prevention
- billing generated totals / invoice truth
- inventory ledger / effective-stock truth
- tenant / client / store scope or permissions
- connector / provider capability truth

### Backend layers (split the ownership; don't pile it into one route)

- **domain / workflow services** own business decisions
- **policy services** own allow/deny and eligibility
- **connectors / adapters** translate provider payloads
- **routes / controllers** validate and delegate (stay thin)
- **workers / jobs / webhooks** perform slow or external-provider reconciliation
- **read models / DTOs** provide fast UI display state
- **final guards** enforce safety at mutation boundaries

### Avoid backend overload (anti-monolith)

- Do not put all logic into one huge route/controller.
- Do not make Orders-page reads call every external provider live.
- Do not mix provider sync, rate shopping, billing generation, inventory recomputation, and label
  purchase into one synchronous endpoint.
- Prefer background jobs/webhooks for slow provider work; read models/DTOs for fast page loads;
  small domain services over giant service files.
- Preserve idempotency, audit trails, retries, and stale-state diagnostics.

### Final guard rule

> Even when read models / cache / background jobs keep data fresh, dangerous mutations must
> re-check safety at the backend boundary immediately before the side effect.

- **Before buying postage:** re-check the local shipped/cancelled lock, upstream/source shipped
  risk, active-shipment / duplicate-label risk, selected-rate proof/freshness, carrier/account/
  service eligibility, and tenant/client/store scope.
- **Before billing generation:** use the backend billing generator / frozen line-item rules, not
  frontend totals.
- **Before inventory mutation:** use the backend inventory/package ledger services, not frontend
  stock math.

### Current frontend hotspots (audit note)

These files today contain frontend-side backend/domain logic and must be treated carefully in
future work — gradually move *authoritative decisions* into backend canonical owners while leaving
pure UI/display helpers in the frontend:

- `web/src/components/Views/OrdersView.tsx`
- `web/src/lib/v2-apiClient.ts`
- `web/src/hooks/v2Hooks.ts`
- `web/src/components/RateBrowserModal.tsx`
- `web/src/components/Views/orders-parity.ts`
- `web/src/components/Views/billing-parity.ts`
- `web/src/components/Views/BillingView.tsx`
- `web/src/components/Views/InventoryView.tsx`
- `web/src/components/Views/DashboardView.tsx`
- `web/src/components/Settings/CarrierIntegrationsCard.tsx`
- `web/src/contexts/MarkupsContext.tsx`
- `web/src/components/Views/orders-panel-state.ts`

### Ownership matrix (per domain)

| Domain | Frontend may do | Backend / read-model must own |
|---|---|---|
| Orders table | render rows, filters, selected IDs, UI state | canonical row DTO, status locks, safe actions, block reasons |
| Best Rate / Rate Browser | display rates, request refresh, show diagnostics | eligible carrier set, rate-shopping orchestration, best rate, proof/freshness |
| Label purchase / Print Queue | send operator intent, show progress | purchase orchestration, duplicate-label guard, queue durability, idempotency |
| Marketplace / source sync | show source status and alerts | webhooks, polling/reconciliation, external shipped/cancelled truth |
| Billing | edit drafts, show generated rows | generated line items, totals, margins, frozen invoice truth |
| Inventory / packages | show stock / read-model state, draft adjustments | ledger movements, effective stock, package-stock truth |
| Dashboard / analytics | render charts and filters | aggregates, cancelled/shipped filtering semantics, read models |
| Carrier / store integrations | render forms and capability UI | provider capability registry, credential validation, account scope |
| Walmart purchaseOrderId (PS-199) | display the resolution source badge | `src/services/walmart-po-resolution.ts` — the LIVE Walmart Marketplace lookup OWNS customerOrderId→purchaseOrderId translation; `store_orders` is a cache in front of it (read-before, upsert-after). Quote and label paths consume the same resolver; real orders never borrow another order's PO. |
| Auth / scope | hide/show UX affordances | RBAC, client/store/tenant enforcement |

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
