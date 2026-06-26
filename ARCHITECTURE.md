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

## Root-cause / imperfect-data injection rule

A symptom is the *last* place bad data shows up, not the first. Before fixing, trace the
data **backwards** to the earliest point where bad, stale, incomplete, ambiguous, or
less-than-perfect data can first enter the workflow — a sync/webhook, an import, a provider
payload translation, a default/fallback value, a cache write, or a user-input boundary —
and fix the canonical source-of-truth owner there, so every downstream consumer becomes
correct for free.

> **Root-cause / imperfect-data rule:**
> For every non-trivial change, identify where bad, stale, incomplete, ambiguous, or
> less-than-perfect data can first enter the workflow. Do not patch only the visible
> symptom. Fix the canonical source-of-truth owner, make callers delegate to it, and add
> boundary tests at that owner. UI/routes/adapters may display, validate input shape, or
> translate provider payloads, but they must not own backend-critical business truth.

> **Fast rejection rule:**
> A PR is incomplete if it only changes the visible symptom and does not explain why the
> canonical source of truth is already correct or how the fix moved the rule to that source
> of truth.

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

### Backend source-of-truth owners (non-negotiable)

These concerns are backend / source-of-truth owned. The frontend, routes, and adapters may
display, validate input shape, or translate provider payloads — but must never own the
decision or mint the value. If a change touches any of these and the diff is frontend-only,
treat it as misplaced until proven the backend owner is already correct (Fast rejection rule):

- **Best Rate selection** and rate-shopping orchestration
- **Package facts / dims / weight** source of truth
- **Carrier / account eligibility**
- **Shipping service eligibility**
- **Effective insurance / confirmation / shipping options** resolution
- **Selected-rate proof / quote-reference validity** and rate freshness
- **Label purchase validity** (final pre-postage re-validation)
- **Print Queue durability** and idempotency
- **Marketplace confirmation / fulfillment outbox** truth
- **Billing generated charges** / frozen invoice totals
- **Inventory movements** / effective-stock ledger
- **Auth / RBAC / client / store scope**

> **Frontend Boundary Law — enforcement (PS-305).** The list above is not advisory.
> `scripts/ps-305-authority-drift-guard.ts` recursively scans `web/src` and FAILS the CI
> gate when a backend-critical authority pattern appears in a non-allowlisted frontend
> file: direct label-purchase orchestration (`createDirectCarrierLabelThenQueue`),
> money-path queue routing (`classifyQueueOrderRoute`), hard-coded HUGRAB insurance
> (`HUGRAB_DEFAULT_INSURED_VALUE`), or frontend-minted rate fingerprints / selected-rate
> proof (`buildShippingRateRequestFingerprint`, `selectedRateAuthorityKey`, `createHash`).
> Known existing debt (OrdersView / shipping-routes) is narrowly allowlisted pending the
> PS-302/303/306 cutover, and the guard RATCHETS — these patterns may not spread to new
> files. A frontend-only diff that introduces one of them is rejected by CI, not review.

> **Rate Source-of-Truth Lockdown (PS-313).** Rate authority is a backend owner cluster,
> not a UI, route, or wrapper convenience:
>
> - `src/services/rates-combined.ts#combineCarrierUniverses` owns the combined ShipStation
>   plus direct-carrier universe, completeness diagnostics, and the cross-universe winner.
> - `src/services/rates.ts#pickBestRate` is the provider-level selector inside the backend
>   rate service, after eligibility, insurance, confirmation, other carrier amounts, and
>   markup normalization are applied.
> - `src/services/shipping-workflow/rate-quote-snapshot-store.ts` owns backend-issued
>   quote references for selected-rate purchase boundaries.
> - `src/services/shipping-workflow/rate-fingerprint.ts` owns selected-rate proof validation.
>
> - Best Rate ranking happens only in the backend canonical rate authority.
> - Rate Browser and Awaiting Shipment Best Rate must consume the same backend-selected best rate.
> - Markups, confirmation, insurance, and other carrier amounts are applied before ranking.
> - Frontend sorting is display-only and cannot declare or persist official bestRate.
> - Frontend cannot mint selected-rate proof.
> - Billing and Shipped views display selected/purchased shipment rate truth, not current Best Rate.
> - `npm run test:rate-source-of-truth` enforces this contract and must be run for rate
>   authority, rate proof, Rate Browser, selected/purchased rate display, Billing rate
>   display, and Best Rate persistence changes.

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
2. **Where does that fact live today, and where can imperfect data first enter it?** Search
   for the canonical owner AND the earliest point where bad/stale/incomplete/ambiguous data
   can enter (sync/webhook, import, provider payload, default/fallback, cache write, input).
   Is the fact duplicated across UI / routes / adapters / services?
3. **Is the right owner deeper than where the bug showed up?**
   - Yes → place the change at the canonical owner; make the symptom site a thin consumer.
   - No (it is genuinely presentation/transport) → fix it at that layer and say why.
4. **Which callers should now delegate** to the owner instead of re-deriving the fact?
5. **What duplicate logic can be removed** (or marked as explicit follow-up debt)?
6. **Which boundary test pins the rule at the owner?** Add it there, not only at the UI.

## Anti-patterns to reject

- ✗ Fixing where bad data *surfaces* instead of where it first *entered* the workflow.
- ✗ Patching the nearest UI component/helper when the rule belongs in a service.
- ✗ Frontend computing money, choosing the final/best rate, or minting a proof.
- ✗ Adapters deciding cross-workflow policy (eligibility, insurance, winner selection).
- ✗ Fat routes with business logic instead of thin validate→call-service→return-DTO.
- ✗ Duplicating the same mapping in two layers so they can silently disagree.
- ✗ A second "fallback" source of truth that can diverge from the canonical one.
- ✗ Showing a provisional value (e.g. "best so far") as if it were final/complete.
- ✗ "Fixing" a failing boundary test by moving the assertion to the UI.

## Backend Truth & No Source-of-Truth Bypass Law

(PS-316 strengthens the earlier No-Source-of-Truth-Bypass-Wrappers rule with explicit
frontend/backend placement and a direct-source preference.) These rules apply to every new
code change, refactor, bug fix, and AI-generated patch:

1. **Backend owns business truth.** The frontend may display backend state, collect user intent,
   format dates/numbers, and show non-authoritative previews — it must NOT own authoritative
   business logic that belongs in backend services, policies, read models, or workflow owners.
2. **Do not put backend logic in the frontend.** Never place money, totals, pricing, rates,
   discounts, eligibility, inventory movement, cost layers, COGS, billing, auth/scope, reporting
   windows, customer visibility, status transitions, shipped/cancelled locks, labels/postage,
   carrier selection, marketplace confirmations, external side effects, or persistence decisions
   in React/UI code as the source of truth.
3. **Prefer direct source-of-truth calls over wrappers.** When code can call the canonical
   source-of-truth service / read model / policy directly, do that — do not add a wrapper /
   helper / adapter just to make the current file easier while hiding where truth actually lives.
4. **Wrappers are allowed only when thin and necessary** — translate external/provider shapes,
   normalize units/names/dates, preserve compatibility, or delegate to a canonical owner. Boring,
   thin, traceable.
5. **Wrappers must not become a second source of truth.** They must not own business rules,
   choose authoritative values, calculate authoritative totals / prices / rates / inventory /
   billing / reporting / auth decisions, rank or select "best" options, persist authoritative
   state, silently fall back to stale / cached / alternate truth, or bypass the canonical owner.
6. **If a wrapper needs business logic, stop** — move the rule to the backend / domain source of
   truth, make the wrapper delegate, and add boundary tests at the canonical owner.
7. **Every PR must prove placement** — name the canonical owner touched, the callers that
   delegate to it, and the boundary tests; if the change is purely visual, say so explicitly.

**PrepShip examples.** Best Rate / Rate Browser ranking + selected-rate proof live in the backend
rate owner (not React); Print Queue create/recover/route is backend-owned; label purchase +
carrier selection are backend money-path decisions; billing export totals come from the billing
source of truth (the FE never recomputes them); shipment sync + package / inventory read models
are backend-owned and the FE renders their DTOs verbatim. (See also [AGENTS.md](AGENTS.md).)

## Required architecture placement note (non-trivial PRs)

Every non-trivial PR states:

- **Business rule / workflow changed:** …
- **Where bad/stale/incomplete data could have entered** before this fix: …
- **Canonical owner / source of truth:** file + symbol.
- **Why this layer** (is the canonical owner): …
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
