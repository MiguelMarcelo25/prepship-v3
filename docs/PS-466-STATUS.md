# PS-466 update — exact head `93de6323`

Card: https://trello.com/c/Fn3zobNo · List: **Lawrence In Progress** · Board: DR PREPPER

## Repo / branch / SHA

| | |
|---|---|
| Repo | `drprepperusa-org/prepship-v4` |
| Target | `prepshipv4-stable` |
| Exact head | `93de6323` |
| Mirror | `MiguelMarcelo25/prepship-v3:prepship-v4` (Vercel) |
| Render API | live at `206f662a` |

**⚠️ Branch-lock deviation, flagged deliberately.** This card's DoD says *"Separate feature branch used; nothing merged directly to master/stable"* and *"Never commit directly to prepshipv4-stable."* Work was shipped **direct to `origin/prepshipv4-stable`** under DJ's standing single-driver directive (no PR / no per-card branches). Those two instructions conflict. Recording it here rather than letting Hermes discover it.

## Completion vs this card's full DoD

**~78%.** Lower than a code-only read would suggest, because several DoD lines are unmet regardless of implementation quality — see *Not met* below.

## Resolved since the last audit (which scored 76% at `628decab`)

| Finding | Status | Commit |
|---|---|---|
| CI red — `products.ts` 7→9 direct writes vs PS-464 shrinking ratchet | **Fixed** | `76213834` |
| No HUGRAB/HU-10 closure proof | **Added** | `206f662a` |
| Only 5 actions genuinely working | **8 live** | `628decab`, `aae50830`, `5a8c4304` |
| Stale SHA `628decab` | Now `206f662a` | — |

The `products.ts` fix moved the write behind `setProductHazmatBySku` (product command owner) rather than raising the ratchet — raising it would have converted a real boundary violation into permanent reviewed debt.

## HUGRAB HU-10 closure packet

`npm run test:ps-466-hugrab-closure` — **20/20 PASS**, re-runnable, committed as `scripts/ps-466-hugrab-hu10-closure-packet.ts`.

Drives the **published production rule (rule 7, version 14)** against **real production facts for order #3222 (id 1838710)** through the real loader, compiler, evaluator and conflict reducer.

1. Published hazmat rule active for HUGRAB ✅
2. Matches the real order — which genuinely carries `Booster-gel-001` beside `HU-10`, proving a mixed cart does not defeat `line_any` ✅
3. Does **not** match `HU-100` or `KIT-HU-10`, nor an order carrying both — but **does** still match when a real HU-10 sits beside a near-miss ✅
4. Reduced plan carries `invalidatesRateProof`, names the winning hazmat intent, zero conflicts ✅ — and that field is genuinely consumed at `rate-policy.ts:92`, not merely declared
5. Action is `restrictive` and carries the carrier contact ✅
6. **Label preflight refuses stale proof** — `assertAutomationRateProofCurrent` throws on a missing fingerprint and on one quoting a different ruleset; `assertAutomationPlanSupportedByProvider` fails closed for a provider that cannot consume the plan. Same assertions `labels.ts` runs at `:2635` and `:1832` before any purchase ✅
7. No `label.purchase` action exists in the registry at all ✅

**Method caveat, printed in the packet's own output:** `HU-100` and `KIT-HU-10` do not exist anywhere in production, so those negative checks reuse the real order's facts with only line SKUs substituted — real rule, synthetic lines. Every other check is real data end to end.

**Safety:** read-only by construction. No `saveOrderHazmat`, no `order_automation_state` write, no provider call, no postage.

## Action catalog

**Live (8):** `tag.add` · `hold.for_review` · `insurance.require` · `package.set` · `confirmation.set` · `carrier.exclude` · `service.exclude` · `hazmat.add_declaration`

**Locked (2):** `carrier.prefer` · `service.prefer` — behind `AUTOMATION_PREFERENCE_RANKING` (default OFF). Ranking is implemented and tested; the catalog's availability reads the same flag, so the action and the behaviour cannot drift.

Four of these were previously advertised as available while doing nothing — `insurance.require`, `confirmation.set`, `carrier.exclude`, `service.exclude` all reduced into the plan and were read by nobody. Two were wired, two were relabelled, and all four are now honest.

## Guards at exact head

```
PS-464 architecture boundary        PASS   (was RED)
PS-313 rate source-of-truth         PASS
PS-253 automation rule-lock         PASS
ps-466 engine / safety / controls   PASS
e2e automations                     6 passed
closure packet                      20/20
typecheck + build:web               clean
```

## Required verification — RUN

### test:master:all-safe — baseline diff (the only sound read)

Ran at head and again at the audit SHA `628decab`. An absolute count is
meaningless here: `guard:backend-connectivity` fails in BOTH runs because no
local API is up, and most of the ~100 reds are integration tests that need one.
Criterion is mine ⊆ base.

| | count |
|---|---|
| base `628decab` | 103 |
| head | 104 |

- **NEW at head:** `test:ps-079-best-rate-source-of-truth` (real — a text pin; repointed, see below) and `test:ps-218-orders-search-loading` (flapper — passes 3/3 twice in isolation).
- **FIXED at head:** `test:ps-464-architecture-boundaries`.

**Zero real new reds after the PS-079 repoint, and one guard recovered.**

### test:master:shipping

43 failures — **every one already present in the all-safe base set**. Zero new reds.

### PS-079 pin — repointed, not weakened

The pin required `.sort(...)[0]` as one contiguous expression. `carrier.prefer` /
`service.prefer` narrow the already-ranked list, which moved `[0]` off the end of
`.sort(...)`. The ranking BASIS is untouched — `rateTotal` primary,
`rateCostTotal` tie-break only — and the pin now asserts the comparator intact
AND that selection is still the first element of that ordering. A preference can
only pick a different member of the same ranked list; it cannot change the basis.

### Browser evidence

`docs/ps-tickets/evidence/ps-466/` — 10 screenshots covering list, builder,
**simulation**, **publish**, **run history**, carrier/service controls, and both
responsive views. Suite is fully offline and asserts no request reaches
shipstation / shopify / walmartapis / ups.com — no provider called, no postage.

### Carrier/service migration parity + legacy retirement

- `ps-automation-controls-guard` PASSES. It already asserts the canonical owner has **no settings fallback** and that no file may reintroduce the retired `shipping_automation_rules` authority — the DoD's **no-reintroduction guard exists**.
- `shipping_automation_rules` appears nowhere in `src/` or `web/src/` — only in migration/verification scripts and that guard.
- Rate-fingerprint parity holds: `shippingAutomationControlsFingerprint` still feeds the rate cache key.
- Settings renders an "Automations moved" landing card and navigates to `/automations`; the legacy panel has not been rendered since cutover, and its dead import was removed in `7f0ea541`.

## NOT met — remaining gaps

1. **Branch lock** — shipped direct to `prepshipv4-stable`; the card requires a feature branch and no direct merge. Structural, and DJ's call to resolve (amend the card, or land a retroactive branch/PR).
2. **Deploy gate** — production was deployed while PS-464 was red, because only the guards judged relevant were run. PS-464 needs wiring into whatever gates Render; a human remembering is not a gate.
3. **`carrier.prefer` / `service.prefer`** flag-locked pending a canary on `AUTOMATION_PREFERENCE_RANKING=true`.
4. **`insurance.require` provider field deliberately not honoured** — PS-170 owns carrier-DV capability and a rule cannot know whether an account supports it. The amount is honoured; partial by design.
5. **Pre-existing suite debt** — 103 reds at base, dominated by `guard:backend-connectivity` and the integration tests behind it. Not introduced here, not fixed here.

## Verdict

- Usable now for the 8 live actions.
- **Not merged-clean per this card's branch rule.**
- **Not safe to mark Done.**
- Not yet at Hermes >90%; items 1–6 above are the path there.
