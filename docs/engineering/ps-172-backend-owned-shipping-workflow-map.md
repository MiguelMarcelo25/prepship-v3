# PS-172 — Backend-Owned Shipping Workflow Without Backend Monolith (Phase 0 map)

> Umbrella/planning deliverable. **No behavior change ships with this doc.** It maps the current
> state, names current vs target owners, ranks risk, and sequences the child phases. Principle
> (ARCHITECTURE.md "Backend-Owned Truth Without Backend Monoliths"): *backend owns decisions;
> frontend owns interaction; workers own slow provider work; read models own fast display;
> **final guards own money safety*** — via thin composable services, never one super-endpoint.

## 1. Current call graph — Awaiting → Best Rate → Rate Browser → Create Label → Print Queue

```
OrdersView.tsx (12.3k lines, @ts-nocheck)
 ├─ list:    useOrders → GET /orders (src/routes/orders.ts ~1500-1990 row mapper)
 │             └─ attaches bestRateWorkflow (buildBestRateWorkflowDto, routes/orders.ts:1666-1707)
 │                + PS-120 pending/rating override (order-rate-job-status.ts)
 │                + isTest (PS-186), legacyClientId, canonicalOrder, shipping display fields
 ├─ passive Best Rate: rates-backfill.ts (worker) → getRates (services/rates.ts:1318)
 │                + PS-121 targeted recalc (startBackfillBestRatesForOrderIds)
 ├─ Recalculate: runStrictBestRateRecalculation (OrdersView) → POST /orders/:id/best-rate
 ├─ Rate Browser: RateBrowserModal → apiClient.browseRates → POST /rates/browse
 │                (rates.ts enriches insurance per-candidate; PS-170/171 resolvers)
 ├─ Create Label: createOrQueueLabel / handleBatchAction (OrdersView)
 │                → POST /labels (routes/labels.ts) → createLabelV2 (services/labels.ts)
 │                   gates: assertOrderSafeToShip → eligibility → test-label policy (PS-186)
 │                   → rate-limit → duplicate-label → assertLabelPurchaseRateSelection
 │                   → buildSsLabelRequestBody → ShipStation → persistCreatedLabel
 │                direct carriers: api/carriers/labels.ts (Vercel) — separate entrypoint
 └─ Print Queue: routes/print-queue.ts → services/print-queue.ts (runMergeJob; operator
                 confirmPrintedQueueEntries owns status='printed')
```

## 2. Current decision owners (verified file:line)

| Decision | Current owner | Status |
|---|---|---|
| Order safe to ship (dup/cancelled/external) | `services/fulfillment/shipping-safety.ts` (pure `decideShippingSafety`) | ✅ backend |
| Test-label authority | `services/fulfillment/test-label-policy.ts` (PS-186) | ✅ backend |
| Selected-rate proof (final authority) | `shipping-workflow/rate-fingerprint.ts` `validateExactSelectedRate` / `assertSelectedRateProofForLabelPurchase` | ✅ backend |
| Rate quote snapshot / `rateQuoteId` / `selectedRateKey` | `shipping-workflow/rate-quote-snapshot{,-store}.ts` (rq_/srk_ opaque hashes, 6h TTL, falls back to legacy proof) | ✅ backend (exists — Phase 2 extends) |
| Per-row rate workflow state + allowedActions | `shipping-workflow/best-rate-workflow-dto.ts` + PS-120 `order-rate-job-status.ts` | ✅ backend (Phase 1 extends) |
| HUGRAB insurance capability/premium | `lib/carrier-account-registry.ts` + `shipping-service-eligibility.ts` + `insurance-cost.ts` (PS-170/171) | ✅ backend |
| Carrier-account identity/display | `lib/carrier-account-registry.ts` KNOWN_CARRIER_ACCOUNTS | ✅ backend (FE dupes remain) |
| **Final Best Rate pick / strict apply / clear** | OrdersView (`runStrictBestRateRecalculation`, apply/clear paths) | ❌ FE → Phase 3 |
| **Direct-vs-ShipStation label routing** | OrdersView (`classifyQueueOrderRoute`, direct calls to api/carriers) | ❌ FE → Phase 4 |
| **Durable batch/queue recovery** | OrdersView localStorage (`resumePersistentQueueJob`) | ❌ FE → Phase 4 |
| **Money display (cost/markup/margin)** | OrdersView recompute | ❌ FE → Phase 5 |
| **Queue SKU identity / package defaults display** | OrdersView | ❌ FE → Phase 5 |
| Test-order display + mock rates | OrdersView `isTestOrder` (display-only post-PS-186) + `buildTestRatesForShipment` (:802-881) + FE `V2_CARRIER_ACCOUNT_REFS` (:895-912) | ❌ FE → PS-187 |
| Account→services list + auto-default | FE `CARRIER_SERVICES` (OrdersView :680-726; media-mail auto-default) | ❌ FE → PS-189 |
| Rate TTL (`cacheExpiresAt`) | FE mints now+6h (`withRateRequestMetadata` ~:5573) over backend value | ❌ FE → PS-183 |
| Legacy client-ID remaps / UPS 1Z attribution / origin ZIP / ADMIN_EMAILS | FE tables/regex/hardcodes | ❌ FE → PS-184/185/188/181 |

## 3. Side effects by stage

| Stage | Side effects |
|---|---|
| Rate fetch/browse | provider API calls (rate-limited, cached); rate-quote snapshot write (analytics_cache); order_rate_jobs pending/rating (PS-120) |
| Best-rate save | order_overrides.bestRateJson/At/Dims write (awaiting only) |
| Label purchase | **postage spend**; shipments insert; orders.orderStatus→shipped; inventory deduction (kill-switch `INVENTORY_AUTO_DEDUCT`); fulfillment outbox/marketplace confirmation; billing linkage |
| Print queue | print_queue insert; PDF merge (no status mutation — operator confirm owns 'printed') |
| Void | SS void call; shipment voided; order back to awaiting |

## 4. Risk ranking (highest first)

1. **Money/postage** — label purchase (duplicate label, wrong account/service, uninsured HUGRAB, fake-label-on-real-order [closed by PS-186]).
2. **Shipped/cancelled locks** (CLAUDE.md lockdown) — every mutation path must stay behind `assertOrderEditable`/`awaiting_shipment` filters.
3. **Stale rate** — TTL minting (PS-183), sibling stale rates (closed by PS-121).
4. **Carrier scope/eligibility** — FE service auto-default (PS-189, media-mail compliance), direct-carrier scope.
5. **Customer PII / credentials** — snapshot/proof must stay sanitized (rq_/srk_ pattern).
6. **Performance** — /orders list must stay batched (no N+1; PS-120/PS-186 set-lookup pattern).
7. **Merge-conflict risk** — OrdersView single-writer rule (one in-flight card).

## 5. Reuse inventory — phases EXTEND these; a second parallel surface is an automatic reject

- `best-rate-workflow-dto.ts` → Phase 1 grows `BestRateWorkflowAllowedActions` + states; attach point stays `routes/orders.ts:1666-1707`.
- `order-rate-job-status.ts` (PS-120) → the additive-override pattern for any new in-progress state.
- `rate-quote-snapshot{,-store}.ts` → Phase 2 adds normalized components/expiry/eligibility-version to the EXISTING rq_/srk_ primitive.
- `rate-fingerprint.ts` → remains the final purchase authority in every phase (never bypassed).
- `carrier-account-registry.ts` → Phase 1/5 display fields + PS-189 services list.
- `fulfillment/shipping-safety.ts` + `fulfillment/test-label-policy.ts` → the pure-core/thin-wrapper template for every new money decision.
- FE classifier `orders-parity.ts:797-852` → maps backend states; extend its switch, don't fork it.

## 6. Phase plan (sequential; dependencies explicit)

| Phase | Card | Boundary | Depends on |
|---|---|---|---|
| 0 | PS-172 | this doc | — |
| 1 | PS-173 | backend row workflow DTO + allowedActions (extend BestRateWorkflowDto); absorbs PS-165b display tuple | Phase 0 |
| 2 | PS-174 | rate quote snapshot normalized components (extend rq_/srk_); no enforcement yet | PS-173 |
| 3 | PS-175 | one backend rate workflow entrypoint for passive/recalc/browse; final-only states; integrates PS-170/171; FE final-pick removed | PS-174 |
| 4 | PS-176 | label/print-queue orchestration enforcement (intent + backend routing + idempotent queue + job ids replace localStorage) | PS-174+175 |
| 5 | PS-177 | backend display models (money, carrier identity, queue SKU identity, package defaults) | Phase 4 |
| 6 | PS-178 | OrdersView/RateBrowser/v2-apiClient thin-client decomposition (supersedes PS-166; absorbs PS-167 full split) | PS-173–177 |
| 7 | PS-179 | certification + boundary guards + evidence-backed dead-code cleanup; epic closeout | PS-173–178 |

Independent sweep cards run alongside (before/between phases): Wave 2a = PS-181, PS-190, PS-188,
PS-182 (no OrdersView contention); Wave 2b = PS-187 → PS-189 → PS-184 → PS-185 → PS-183
(OrdersView single-writer, strictly sequential). **PS-186 shipped (Wave 0).**

## 7. Existing-card classification

| Card | Classification |
|---|---|
| PS-120, PS-121, PS-170, PS-171 | **Keep (shipped)** — Phase 3 integrates them into the converged rate workflow; must not be weakened |
| PS-108 | Keep (shipped) — billed-cost reconciliation continues post-purchase |
| PS-165 | **Split**: 165a FE collapse shipped; 165b backend tuple **absorbed into Phase 1 (PS-173)** |
| PS-166 | **Superseded by Phase 6 (PS-178)** — no standalone OrdersView decomposition |
| PS-167 | Safe-partial shipped; full method split **sequenced into Phase 6** |
| PS-154/155/157 | Shipped (FE decomposition); further FE extraction waits for Phase 6 |
| PS-186 | **Done (Wave 0)** — prerequisite for PS-187 |
| PS-187 | Sequenced first in Wave 2b (depends on PS-186 backend isTest) |
| PS-189 | Wave 2b; unblocks the PS-165b account-services half |
| PS-191 | **Undefined — referenced as a dependency of PS-189/PS-190 output; define before sequencing** |

## 8. Child-card drafts (unnumbered; Hermes assigns PS numbers)

- UNNUMBERED DRAFT — Phase 1: extend BestRateWorkflowDto with row workflow states + allowedActions (canRate/canBrowseRates/canRecalculate/canCreateLabel/canQueueLabel/canMarkExternalShipped) + registry display fields; OrdersView prefers DTO behind existing fallback. (= PS-173 as carded.)
- UNNUMBERED DRAFT — Phase 2: normalize rate-quote snapshot components (account, service, amount parts, insurance, confirmation, ZIP+4, residential, weight/dims/package, ship-date bucket, credential context, eligibility version, expiry) on the existing rq_/srk_ primitive; surface in BestRate + RateBrowser. (= PS-174.)
- UNNUMBERED DRAFT — Phase 3: single rate-workflow entrypoint (passive/recalc/browse) returning final-only classified states; delete FE final-pick. (= PS-175.)
- UNNUMBERED DRAFT — Phase 4: ShippingIntent/LabelPurchase/PrintQueue orchestration; backend routing; idempotent queue; job ids replace localStorage recovery. (= PS-176.)
- UNNUMBERED DRAFT — Phase 5: money/carrier/queue-SKU/package display DTOs with provenance. (= PS-177.)
- UNNUMBERED DRAFT — Phase 6: thin-client decomposition + boundary guard vs FE money/rate/label authority reappearing. (= PS-178.)
- UNNUMBERED DRAFT — Phase 7: mocked end-to-end certification gate + perf sanity + evidence-backed dead-code deletion + epic closeout table. (= PS-179.)

## 9. Anti-spaghetti rules (enforced in review on every phase/card)

1. One canonical owner per decision; routes/UI are thin callers (pure-core + thin-IO-wrapper for money decisions).
2. Extend, never parallel — new states into `BestRateWorkflowDto`, new facts onto the existing row DTO, overrides via the PS-120 additive pattern.
3. No new FE business logic — FE reads backend fields only (model: `isBackendTestOrder`, one line).
4. Deletions are guard-backed and replacement-first (backend live + cert green before FE delete).
5. OrdersView is single-writer (one in-flight card).
6. Every PR: typecheck + build:web + card guard + `test:shipping-roundtrip-certification` + checklist outcome line; confirm-before-push when `labels.ts`/`rates.ts`/snapshot/fingerprint change.

## 10. Verification gates per future phase

- Phase 1: DTO contract guard + orders payload byte-parity for rows without new states.
- Phase 2: fingerprint-sensitivity tests (weight/dims/ZIP+4/service/account/insurance/confirmation/residential/eligibility-version each change the key); old-proof fallback intact.
- Phase 3: passive/recalc/browse parity tests; HUGRAB insured totals (ps-072/108/124/125/126/170/171 stay green); no FE "best so far".
- Phase 4: mocked create/queue/batch/direct/stale-proof/duplicate-label/no-real-postage suite; localStorage authority removed.
- Phase 5: DTO-vs-existing-display parity fixtures (awaiting/shipped/cancelled/eBay-no-SKU/multi-SKU/HUGRAB).
- Phase 6: boundary guard (FE money/rate/label decisions cannot reappear); browser workflow evidence.
- Phase 7: full mocked certification + perf sanity + closeout table.
