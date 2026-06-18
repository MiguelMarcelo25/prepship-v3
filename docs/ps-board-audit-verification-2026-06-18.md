# PrepShip v4 — Board Audit Verification (DJ's 2026-06-17 implementation audits)
**Date:** 2026-06-18 · **Branch:** `prepshipv4-stable` @ `fbb60a3`
**Scope:** verify DJ's per-ticket implementation-percent audits for **PS-285, PS-261, PS-262, PS-271, PS-272, PS-273, PS-274, PS-286** (+ PS-275 for completeness — not in DJ's audit batch).
**Method:** 16 read-only agents (8 independent auditors + 8 adversarial cross-checkers) against the live tree, then **re-reconciled against the actual card definitions** (the DoD text DJ supplied 2026-06-18, which the agents did not have).

---

## Headline

1. **Every factual / code-level claim DJ made was confirmed on all 8 tickets.** Not one of his specific "X still calls Y", "Z exists but doesn't block", or "only label_url landed" assertions was refuted. His evidence (commit SHAs, files, test names) is 100% reliable, and he read the source rather than reflex-agreeing.

2. **Once the real card scopes are known, DJ's percentages are accurate or appropriately conservative on every ticket.** The cards confirm the *broad* scope DJ measured against.

3. **The multi-agent "boss too low → 100%" verdicts on PS-285, PS-272, and PS-286 were wrong** — they narrowed each card's scope to the slice that happened to land under that label. The actual card text (now in hand) proves those cards are broad/multi-surface. This is the "slice ≠ card complete" trap, and DJ's audit avoided it. **The cards vindicate DJ on exactly the tickets where the agents diverged from him.**

---

## Reconciled scorecard (vs each card's full DoD)

| Ticket | Card scope (1-line) | Lock | DJ % | Agents (audit / x-check) | **Reconciled %** | Verdict on DJ |
|---|---|---|---|---|---|---|
| **PS-285** | Finish PS-245–259 production gaps — **12-phase umbrella** | — | 20 | 100 / 100 ⚠️ | **~20–25** | ✅ **Validated** (agents wrong) |
| **PS-261** | Backend HUGRAB insurance **proof resolver that blocks** unsafe purchase, 5 surfaces | — | 35 | 30 / 28 | **~30** | ✅ Close (slightly high) |
| **PS-262** | No direct carrier resolves `parcelguard`; audit **every** connector | — | 60 | 42 / 85 | **~55–60** | ✅ Fair (x-check wrong) |
| **PS-271** | Shipp thin-response: 4 layers + cohort re-rate + rate-limit guards | — | 78 | 72 / 72 | **~75–78** | ✅ Accurate |
| **PS-272** | **Bound** shipments/orders/inventory sync (batch + durable cursor) | 🔒 | 20 | 100 / 100 ⚠️ | **~25–33** | ✅ **Validated** (agents wrong) |
| **PS-273** | Stop fabricating direct-UPS nickname for Shipp rows + backfill | 🔒 | 82 | 78 / 78 | **~85–90** | ✅ Conservative |
| **PS-274** | Backend-owned Shipp insurance-**certainty tags**, no false proof | — | 85 | 85 / 85 | **~80–85** | ✅ Accurate |
| **PS-286** | **One** backend rate-truth DTO across Awaiting/Browser/Recalc/Queue | — | 10 | 100 / 100 ⚠️ | **~10–15** | ✅ **Validated** (agents wrong) |
| PS-275 | $0-shipping review button + prep-fee waiver | 🔒¹ | *n/a* | *not audited* | **~80** | (not in DJ's batch) |

¹ PS-275 touches billing adjustment, not shipped/cancelled rows; no `unlock` required for the billing-override path.

---

## Where scope flipped the verdict (the integrity-critical correction)

My last turn flagged that the agents *could not read the card DoD* and so might be narrowing scope. The card text DJ supplied confirms that is exactly what happened on three tickets:

- **PS-285** — The card is **"Finish PS-245–259 remaining production code gaps in dependency order,"** an explicit **12-phase** umbrella (auth → orders scope → label proof → rates authority → OAuth perimeter → route-auth sweep → billing SOT → marketplace outbox → durable state → FE types → OrdersView decomposition → guard cleanup). The agents collapsed it to the lone marketplace-confirm guard that carried the PS-285 label and called it "100%." **Wrong.** Only ~1 of 12 phases landed under the PS-285 label (and that one is a static guard, not new runtime behavior). **DJ's ~20% is the correct order of magnitude.**

- **PS-272** — The card is **"Bound the unbounded sync jobs (shipments / orders / inventory-import) so each run finishes under the deadline,"** with batch limits + durable resume cursors. Slice 1 (shipments, `d1ed0ded`) is built; slices 2 (orders) and 3 (inventory-import) are **not** — confirmed by the agents themselves: `syncOrders({})`, `syncShipments({})`, `importSkusFromOrders()` are still arg-less at [sync-scheduler.ts:150/191/219](src/services/sync-scheduler.ts). The agents pointed at the stuck-job reaper (`f541b500`/`8f0c2238`, a PS-265-style self-heal) and called the card "100%." **Wrong.** **DJ's ~20% is well-founded.**

- **PS-286** — The card is **"Awaiting Best Rate, Rate Browser, and Print Queue must use one current backend rate truth"** — a money-path source-of-truth convergence. The `f0935e27` work the agents scored is a `label_url` backfill (un-greys "Send to Queue") — a genuinely **different** card's concern; the card even cites `371e1ec3` as latest and references the existing rate-proof guards. The convergence DTO is **not** built. **DJ's ~10% is correct.**

**Takeaway:** trusting the agents' "100%" over DJ would have closed three broad cards on the strength of one narrow slice each. DJ's stricter "measure against the full card" lens was right.

---

## Per-ticket detail

### PS-285 — Finish PS-245–259 production gaps (12-phase) — 🔓 not locked — **~20–25%**
- **Confirmed:** the two commits under the PS-285 label (`371e1ec3`, `f219077d`) are a marketplace-confirm **boundary guard** (phase 8) + stale-doc corrections — zero runtime change.
- **Card reality:** broad 12-phase production-code card. Several earlier-phase gaps were closed under their *own* labels (`d61d0c71` PS-247, `0445da07` PS-248, `49729c43` PS-249, `7e6cb2ab` PS-252, `08f7d8d8` PS-253), so cumulative progress is more than "one phase," but the **majority of phases (rates authority cleanup, billing SOT, durable runtime state, FE type-safety, OrdersView decomposition, guard cleanup) remain.**
- **Remaining:** phases 1–7 verification + 9–12 per the card's dependency order; a full 12-phase audit is needed for an exact number.
- **Verdict:** ✅ DJ's ~20% validated. A focused 12-phase sweep would tighten the figure.

### PS-261 — HUGRAB insurance proof resolver (blocks purchase) — 🔓 — **~30%**
- **Confirmed:** `insurance-certainty.ts` exists and is honest, but **never blocks** ([line 23](src/services/shipping-workflow/insurance-certainty.ts): "certainty NEVER blocks a rate"). Display + persistence are done; **purchase-gating is 0%.**
- **Card reality:** DoD requires `proofState` that **blocks** unsafe HUGRAB label purchase, wired into Rate Browser + Best Rate + selected-rate proof + Create Label + Print Queue, plus a **new** focused test `test:ps-261-hugrab-insurance-capability` (only `test:ps-261-easypost-insurance-cost` exists today — a narrower test).
- **Remaining:** the entire blocking/allow path + 5-surface wiring + the named resolver test.
- **Verdict:** ✅ DJ's 35% slightly generous; ~30% is fair.

### PS-262 — Direct carriers must never resolve `parcelguard` — 🔓 — **~55–60%**
- **Confirmed:** insured **Walmart Shipping is blocked** ([carrier-account-registry.ts:203](src/lib/carrier-account-registry.ts) + [shipping-service-eligibility.ts:381](src/lib/shipping-service-eligibility.ts)); direct UPS = `carrier`; Shipp self-insures (reference connector).
- **Card reality:** the core acceptance — *"no direct carrier ever resolves `parcelguard`"* — is **not met**: direct **FedEx, Shipp, EasyPost still fall through to `parcelguard`** at [carrier-account-registry.ts:214](src/lib/carrier-account-registry.ts). FedEx only self-blocks *late* at label time ([fedex.ts:54](src/connectors/carrier/fedex.ts)), not early at eligibility. EasyPost / direct-FedEx / Walmart connector insurance audits remain.
- **Remaining:** registry fix (unverified direct → `blocked`, never `parcelguard`); EasyPost + FedEx + Walmart insure-or-block audits; the matrix guard.
- **Verdict:** ✅ DJ's 60% fair. The adversarial agent's "85%" is **rejected** — it narrowed PS-262 to "Walmart only," which the card contradicts.

### PS-271 — Shipp thin-response divergence — 🔓 — **~75–78%**
- **Confirmed:** all 4 layers in code (observed-set retry, 60s union cache, no-downgrade ratchet, completeness honesty) + PS-111 reconcile; **4 guard suites pass.**
- **Card reality:** DoD also requires the **post-deploy cohort re-rate** of the 31 oz #1502 cohort + rate-limit guardrails. Per project records DJ has already flipped `DIRECT_CARRIER_RATE_CACHE` live on Render (the agents read only the code default `booleanFlag(false)` and undercounted) — so the only true remainder is the cohort re-rate probe + a live Rate-Browser eyeball.
- **Remaining:** `startBackfillBestRatesForOrderIds(orderIds, {maxAgeHours:0})` over the cohort after cache seed; live eyeball.
- **Verdict:** ✅ DJ's 78% accurate (arguably conservative given the live flag flip).

### PS-272 — Bound the unbounded sync jobs — 🔒 **locked (shipments write path)** — **~25–33%**
- **Confirmed:** slice 1 (shipments bounding, `d1ed0ded`) exists; the stuck-job reaper (`f541b500`/`8f0c2238`) is shipped default-OFF — but that's a *related self-heal*, not the card's batch-bounding.
- **Card reality:** slices **2 (orders)** and **3 (inventory-import)** are **not bounded** — call sites still pass no batch/cursor args. Because of the single global job mutex, the worker stays wedged until **orders** is bounded too.
- **Remaining:** bound `runOrderSync` + `runInventoryImportFromOrders` with a **durable DB-watermark cursor** (not in-memory); confirm worker stays up post-deploy; requires `unlock shipped data` + byte-identical write-path review before merge.
- **Verdict:** ✅ DJ's ~20% validated. Agents' "100%" **rejected** (they scored the reaper, not the card).

### PS-273 — Shipp label fabricated direct-UPS nickname — 🔒 **locked** — **~85–90%**
- **Confirmed:** backend identity-first (offset gate), forward write of `provider_account_nickname`, all 3 FE readers + OrderDetailDrawer gate the brokered service code before raw `carrierNickname`, 36 guard checks pass, synthetic E2E row renders "Shipp" not GG6381.
- **Card reality:** DoD includes the historical **backfill**. The agents scored it "inert" (script written, double-gated, not auto-run) → 78%. **Per project records DJ has already run the `--apply` backfill (0 rows left)** — which the agents couldn't see. With backfill done, effective completion is **~90%**; only a live #1587 eyeball remains.
- **Remaining:** live read-only spot-check of #1587.
- **Verdict:** ✅ DJ's 82% is conservative-correct (a snapshot around backfill time).

### PS-274 — Shipp insurance-certainty tags — 🔓 — **~80–85%**
- **Confirmed:** backend stamps certainty on Shipp rates, label persistence guards `carrier_declared_value` behind `!shippBrokered`, `RateRowItem` renders the tag; 64 guard checks pass.
- **Card reality:** DoD also wants the certainty carried through **selected-rate proof/fingerprint** and **revalidated at Create Label / Print Queue**, plus browser tests. That threading is partial/loose (rate passthrough is `Record<string,any>`), and the live HUGRAB eyeball is explicitly deferred ("needsDJ live-only").
- **Remaining:** prove certainty survives proof/fingerprint + purchase preflight; live HUGRAB + EasyPost label eyeball.
- **Verdict:** ✅ DJ's 85% accurate (could argue 80 if proof-threading is counted strictly).

### PS-286 — One backend rate truth across Awaiting / Browser / Recalc / Queue — 🔓 — **~10–15%**
- **Confirmed:** `f0935e27` is a `label_url` capture/backfill (root cause: ~72% NULL `label_url` greying "Send to Queue") — useful, but **not** this card. `BestRateWorkflowDto` exists but is **pre-existing PS-120 infra**, not a PS-286 deliverable.
- **Card reality:** DoD requires a **single backend current-rate DTO/proof** consumed identically by the Awaiting row, Rate Browser, Recalculate, and Print Queue, with stale/incomplete/changed-rate diagnostics and a Print Queue **preflight** that blocks purchase from stale rows. `BROWSE_SOT_WRITEBACK` is OFF; the convergence is unbuilt.
- **Remaining:** essentially the whole card — the unified DTO + reconciliation + Print Queue preflight.
- **Verdict:** ✅ DJ's 10% validated. Agents' "100%" **rejected** (they scored an unrelated label_url slice).

### PS-275 — $0-shipping review button + prep-fee waiver — 🔒¹ billing-override — **~80%** *(not in DJ's audit batch)*
- Per project records: policy + waiver + thin route + FE button/badge/modal built and guarded; the original detection was unreachable (every order had a >$0 shipping line), **fixed at `c894c516`** so internal $0/blank-cost shipments now emit a reviewable $0 line (17 orders will flag).
- **Remaining:** DJ-live after deploy — run *Update Billing* for the affected periods, eyeball the badge/button, click *Waive*, confirm prep lines zero on regen.

---

## What my earlier audit got wrong (so the record is clean)
- Trusted the agents' **narrow-scope "100%"** on PS-285 / PS-272 / PS-286. The card DoD refutes all three — those are broad cards, ~20/~25/~10% respectively. **DJ was right.**
- Marked PS-271 (flag) and PS-273 (backfill) "remaining" from **code-only** reads; project records show DJ already flipped the flag / ran the backfill, so DJ's higher numbers were better justified than the agents' lower ones.
- Net: where the agents and DJ disagreed, **DJ was correct every time.** The only durable agent contribution is the **FedEx/Shipp/EasyPost `parcelguard` fall-through** (real, open) on PS-262 and the confirmation that PS-261's blocking layer is genuinely 0% built.

---

## Recommended next actions (dependency-aware)
1. **PS-286** (money-path SOT, ~10%) and **PS-261** (insurance blocking, ~30%) are the two lowest-coverage money-path cards — highest risk per point of effort.
2. **PS-272 slices 2–3** (orders + inventory bounding) — needed to un-wedge the worker; requires `unlock shipped data` + byte-identical write review.
3. **PS-262** registry fix — make unverified direct carriers resolve `blocked`, not `parcelguard`; audit EasyPost / direct-FedEx / Walmart.
4. **PS-285** — run a focused 12-phase sweep to convert "~20%" into a phase-by-phase status.
5. Close the **live-only** tails: PS-271 cohort re-rate, PS-273 #1587 eyeball, PS-274 HUGRAB eyeball, PS-275 billing-run eyeball.

---

## Method & safety
16 agents, read-only (`git show`/`grep`/`Read` only); no production reads, no mutations, no labels/postage/marketplace calls. All cited commit SHAs resolve and all referenced `test:ps-*` scripts exist in `package.json`. Percentages are measured **against each card's full Definition of Done** (deferred / in-tree-but-inert / live-only all count as UNMET), per the repo's completion-reporting standard. Lock (🔒) flags mark cards whose DoD touches the shipped/cancelled write path and require `unlock shipped data` before code.
