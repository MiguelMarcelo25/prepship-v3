# Shipping Purchase Boundary Task Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save and execute DJ's PS-084, PS-087, and PS-093 through PS-099 shipping tasks with visible completion percentages and safe certification before marking any ticket 100%.

**Architecture:** Work in PS order, but recognize that `prepshipv4-stable` already contains the direct-carrier scope work and selected-rate proof enforcement commits. Preserve those shipped safeguards, add missing certification/reporting where task definitions require it, then continue with the remaining print queue and SHIPP label-output work.

**Tech Stack:** TypeScript, Hono routes, Vercel API functions, React Orders UI, Drizzle/Postgres schema, Playwright/browser certification, static guard scripts, offline/mock shipping certification.

---

## Current Status Snapshot

Last reviewed on 2026-06-05 against `prepshipv4-stable` after:

- `6b441ae3` - `PS-083: hide unassigned direct carriers from Rate Browser + enforce assignment scope`
- `baf87525` - `PS-085 audit shipping workflow orchestrator`
- `edbce02f` - `Enforce selected-rate proof at label purchase`

| Ticket | Current Percent | Status | Evidence / Notes |
|---|---:|---|---|
| PS-084 Direct-Carrier Print-to-Queue Ship-To + Existing Label Recovery | 100% | Complete and verified. | Direct-carrier labels now resolve local order ship-to fallback and direct-carrier print-to-queue sends canonical `shipTo`; existing-label recovery remains duplicate-postage-safe. See `docs/ps-084-direct-carrier-print-queue-completion-report.md`. |
| PS-087 Diagnose, Recover, and Close All Unfinished PrepShip V4 Tasks | 20% | Saved/planned; PS-084 and PS-098 now closed with evidence. | Broad closeout/meta ticket; should run after PS-099 and the PS-094/PS-095 closeout decisions are complete. |
| PS-093 Direct-Carrier Scope Guard for Rates + Labels | 100% | Functionally complete and verified. | `src/lib/direct-carrier-scope.ts`; `api/carriers/rates.ts`; `api/carriers/labels.ts`; `npm run test:ps-083-direct-carrier-scope`; `npm run test:direct-carrier-labels`; `npm run test:direct-carrier-queue-route`; `npm run test:carriers-rates-hardening`. |
| PS-094 Backend Selected-Rate Proof/Fingerprint Primitive | 90% | Functionally present via PS-085 `rate-fingerprint.ts`, but task asked for a no-enforcement phase and file name `rate-selection-proof.ts`. | Need decide whether to add compatibility alias/doc or mark superseded by `rate-fingerprint.ts` + enforcement. |
| PS-095 Frontend Selected-Rate Proof Pass-Through + Stale-Rate UX | 85% | Proof pass-through is implemented. Stale UX needs final review against task wording. | `web/src/components/Views/OrdersView.tsx` passes `selectedRateProof`; existing rate-sync UI handles stale/unavailable states. |
| PS-096 Enforce Selected-Rate Proof on ShipStation Label Purchase | 100% | Complete and verified. | `src/routes/labels.ts`; `src/services/labels.ts`; `npm run test:selected-rate-proof-boundary`; `npm run test:shipping-roundtrip-certification`; `npm run test:full-site-certification`. |
| PS-097 Enforce Selected-Rate Proof on Direct-Carrier Label Purchase | 100% | Complete and verified. | `api/carriers/labels.ts`; `npm run test:selected-rate-proof-boundary`; `npm run test:direct-carrier-labels`; `npm run test:shipping-roundtrip-certification`. |
| PS-098 Shipping Purchase-Boundary Certification | 100% | Complete and verified. | Dedicated certification guard and report map PS-093 through PS-097 allowed/blocked paths. See `docs/ps-098-shipping-purchase-boundary-certification.md`. |
| PS-099 Separate Create+Print from Print Queue + Normalize SHIPP 4x6 Label Output | 0% | Saved/planned only. | Needs implementation after PS-098 certification, unless DJ prioritizes label-output bug first. |

## Global Safety Rules

- Do not buy real labels/postage.
- Do not void labels.
- Do not send live marketplace notifications.
- Do not mutate real shipped/cancelled orders unless DJ explicitly grants `unlock shipped data` in the current conversation.
- Do not weaken auth, RBAC, client/store/provider scope, credential redaction, duplicate-label safety, or existing shipped/cancelled guards.
- Do not expose secrets, raw provider payloads, raw labels, or customer PII.
- Use mocked/offline/static certification first. Browser/E2E is required only when operator-visible behavior changes.

## Execution Strategy

1. Stabilize the status ledger before coding.
2. Complete the existing PS order without renumbering tasks.
3. For any ticket already implemented by a prior commit, do certification/report-only work instead of rewriting.
4. Use one narrow commit per ticket or certification slice.
5. Report a ticket as 100% only when:
   - code/docs/tests required by the ticket exist,
   - listed verification commands pass or nearest equivalent is documented,
   - no prohibited live side effects occurred,
   - exact files changed are reported,
   - follow-up risks/blockers are listed.

---

## Task 1: PS-084 Direct-Carrier Print-to-Queue Recovery

**Files:**
- Inspect: `web/src/components/Views/OrdersView.tsx`
- Inspect: `api/carriers/labels.ts`
- Inspect: `src/services/print-queue.ts`
- Inspect: `src/routes/print-queue.ts`
- Modify/Test: `scripts/direct-carrier-queue-route-guard.ts` or add `scripts/direct-carrier-print-queue-recovery-guard.ts`

- [x] **Step 1: Write a failing guard for local ship-to resolution**

Guard should assert that direct-carrier print-to-queue sends `orderId` and lets `api/carriers/labels.ts` load local `orders.raw`/store order data before provider label purchase.

Run:

```powershell
npm run test:direct-carrier-queue-route
```

Expected before implementation if missing: FAIL on missing local-order lookup assertion.

- [x] **Step 2: Write a failing guard for existing-label recovery**

Guard should assert that print-to-queue reuses an existing active label URL when present and does not purchase another direct-carrier label.

Run:

```powershell
npm run test:print-queue-invalid-label
npm run test:direct-carrier-queue-route
```

Expected before implementation if missing: FAIL on existing-label reuse/recovery assertion.

- [x] **Step 3: Implement minimal recovery behavior**

Only touch the print-to-queue path needed to:

- prefer existing queueable label URLs,
- use local order ship-to data for direct-carrier label creation,
- return safe errors when local ship-to is missing,
- avoid buying a duplicate label.

- [x] **Step 4: Verify PS-084**

Run:

```powershell
npm run typecheck
npm run test:direct-carrier-queue-route
npm run test:print-queue-invalid-label
npm run test:shipping-roundtrip-certification
```

PS-084 is 100% as of commit containing `scripts/ps-084-direct-carrier-print-queue-guard.ts` and `docs/ps-084-direct-carrier-print-queue-completion-report.md`.

---

## Task 2: PS-093 Scope Guard Certification Closeout

**Files:**
- Existing: `src/lib/direct-carrier-scope.ts`
- Existing: `api/carriers/rates.ts`
- Existing: `api/carriers/labels.ts`
- Existing: `scripts/ps-083-direct-carrier-assignment-scope-guard.ts`

- [x] **Step 1: Confirm reusable scope guard exists**

Current implementation uses `src/lib/direct-carrier-scope.ts` instead of the requested `src/services/shipping-workflow/carrier-account-scope.ts`.

- [x] **Step 2: Confirm rate and label paths call guard before provider calls**

Verified by static guard and file inspection.

- [x] **Step 3: Run PS-093 verification**

Passed:

```powershell
npm run typecheck
npm run test:ps-083-direct-carrier-scope
npm run test:direct-carrier-labels
npm run test:direct-carrier-queue-route
npm run test:carriers-rates-hardening
```

PS-093 status: 100%.

---

## Task 3: PS-094 Proof Primitive Compatibility Closeout

**Files:**
- Existing: `src/services/shipping-workflow/rate-fingerprint.ts`
- Existing: `src/services/rates.ts`
- Optional Create: `src/services/shipping-workflow/rate-selection-proof.ts`
- Modify/Test: `scripts/ps-085-shipping-workflow-guard.ts` or add a narrow alias guard.

- [ ] **Step 1: Decide compatibility strategy**

Because PS-085 already created `rate-fingerprint.ts`, choose one:

- Option A: Keep `rate-fingerprint.ts` as canonical and document PS-094 as superseded/fulfilled by PS-085.
- Option B: Add `rate-selection-proof.ts` as a small re-export/alias module so the board task name maps to code without duplicating logic.

Recommended: Option B, a re-export module, because it gives the ticket the requested file without a rewrite.

- [ ] **Step 2: Add guard assertion for safe proof primitive**

Guard must prove:

- fingerprint changes when weight/dims/provider/service/confirmation/insurance changes,
- proof excludes raw secrets and raw labels,
- label behavior is not changed by this compatibility alias.

Run:

```powershell
npm run test:ps-085-shipping-workflow
npm run test:ps-079-best-rate-source-of-truth
npm run test:ps-081-rate-sync
```

- [ ] **Step 3: Mark PS-094 100%**

Only after alias/doc decision is committed and verification passes.

---

## Task 4: PS-095 Frontend Proof Pass-Through + Stale UX Closeout

**Files:**
- Existing: `web/src/components/Views/OrdersView.tsx`
- Inspect: `web/src/lib/v2-apiClient.ts`
- Inspect: `web/src/components/RateBrowserModal.tsx`
- Test: `scripts/selected-rate-proof-purchase-boundary-guard.ts`
- Test: `scripts/ps-081-rate-sync-guard.ts`

- [x] **Step 1: Proof pass-through exists**

`OrdersView.tsx` builds and passes `selectedRateProof` into single, batch, direct-carrier queue, and backend queue label payloads.

- [ ] **Step 2: Certify stale proof UX wording**

Confirm the UI clearly nudges operators to re-rate when proof is missing/stale and does not imply stale rates are acceptable.

- [ ] **Step 3: Add focused guard only if existing certification misses stale UX**

Prefer static/browser-safe assertion rather than broad UI rewrite.

Run:

```powershell
npm run typecheck
npm run test:ps-081-rate-sync
npm run test:selected-rate-proof-boundary
npm run test:full-site-certification
```

Mark PS-095 100% after stale UX is explicitly certified.

---

## Task 5: PS-096 ShipStation Proof Enforcement Closeout

**Files:**
- Existing: `src/routes/labels.ts`
- Existing: `src/services/labels.ts`
- Existing: `src/services/shipping-workflow/rate-fingerprint.ts`
- Existing: `scripts/selected-rate-proof-purchase-boundary-guard.ts`

- [x] **Step 1: ShipStation proof is enforced before connector purchase**

`createLabelV2` calls `assertSelectedRateProofForLabelPurchase(body.selectedRateProof)` before `createCarrierLabel('shipstation', ...)`.

- [x] **Step 2: Safe typed error exists**

`src/routes/labels.ts` returns `400` with `SELECTED_RATE_PROOF_INVALID`.

- [x] **Step 3: Run PS-096 verification**

Passed:

```powershell
npm run typecheck
npm run test:selected-rate-proof-boundary
npm run test:ps-079-best-rate-source-of-truth
npm run test:ps-081-rate-sync
npm run test:shipping-roundtrip-certification
npm run test:full-site-certification
```

PS-096 status: 100%.

---

## Task 6: PS-097 Direct-Carrier Proof Enforcement Closeout

**Files:**
- Existing: `api/carriers/labels.ts`
- Existing: `src/services/shipping-workflow/rate-fingerprint.ts`
- Existing: `scripts/selected-rate-proof-purchase-boundary-guard.ts`

- [x] **Step 1: Direct-carrier proof is enforced before provider purchase**

`api/carriers/labels.ts` calls `assertSelectedRateProofForLabelPurchase(body?.selectedRateProof)` after scope validation and before provider-specific label branches.

- [x] **Step 2: Safe typed error exists**

The Vercel function returns `400` with `SELECTED_RATE_PROOF_INVALID`.

- [x] **Step 3: Run PS-097 verification**

Passed:

```powershell
npm run typecheck
npm run test:selected-rate-proof-boundary
npm run test:direct-carrier-labels
npm run test:direct-carrier-queue-route
npm run test:carriers-rates-hardening
npm run test:shipping-roundtrip-certification
npm run test:full-site-certification
```

PS-097 status: 100%.

---

## Task 7: PS-098 Purchase-Boundary Certification

**Files:**
- Inspect: `scripts/shipping-roundtrip-certification.mjs`
- Inspect: `scripts/selected-rate-proof-purchase-boundary-guard.ts`
- Optional Create: `docs/ps-098-shipping-purchase-boundary-certification.md`
- Optional Modify: `package.json` if adding an aggregate script.

- [x] **Step 1: Create certification table artifact**

Save a table with:

- PS-093 unassigned inactive wrong-client direct carrier blocked before provider calls.
- PS-094 proof primitive redacts secrets/PII and changes on rate-affecting fields.
- PS-095 frontend passes proof to all label payload paths.
- PS-096 ShipStation missing/stale/mismatched proof blocked before connector call.
- PS-097 direct-carrier missing/stale/mismatched proof blocked before connector call.
- Allowed exact-proof paths remain allowed in mocked/offline mode.

- [x] **Step 2: Run aggregate verification**

Run:

```powershell
npm run typecheck
npm run test:ps-079-best-rate-source-of-truth
npm run test:ps-081-rate-sync
npm run test:ps-083-direct-carrier-scope
npm run test:selected-rate-proof-boundary
npm run test:direct-carrier-labels
npm run test:direct-carrier-queue-route
npm run test:carriers-rates-hardening
npm run test:shipping-roundtrip-certification
npm run test:full-site-certification
```

- [x] **Step 3: Mark PS-098 100%**

PS-098 is 100% as of the commit containing `scripts/ps-098-shipping-purchase-boundary-certification-guard.ts` and `docs/ps-098-shipping-purchase-boundary-certification.md`.

---

## Task 8: PS-099 Separate Create+Print From Print Queue + Normalize SHIPP 4x6 Output

**Files:**
- Inspect: `web/src/components/Views/OrdersView.tsx`
- Inspect: `api/carriers/labels.ts`
- Inspect: `src/connectors/carrier/shipp.ts`
- Inspect: `src/services/print-queue.ts`
- Test: add focused guard for Create+Print not queueing and SHIPP label size normalization.

- [ ] **Step 1: Write failing guard for Create+Print separation**

Assert:

- Create+Print opens/returns the label PDF path.
- Create+Print does not add the label to print queue.
- Print-to-Queue still adds a queue entry.

- [ ] **Step 2: Write failing guard for SHIPP 4x6 output**

Assert:

- SHIPP labels normalize to 4x6 output metadata.
- Returned/queued label URL is a printable PDF or safe converted representation.
- No raw provider label payload is exposed.

- [ ] **Step 3: Implement minimal behavior**

Keep Create+Print and Print-to-Queue as separate commands. Normalize SHIPP output at the connector/label boundary, not by adding UI-only workarounds.

- [ ] **Step 4: Verify PS-099**

Run:

```powershell
npm run typecheck
npm run test:direct-carrier-labels
npm run test:direct-carrier-queue-route
npm run test:print-queue-invalid-label
npm run test:shipping-roundtrip-certification
npm run test:full-site-certification
```

Mark PS-099 100% only after proof that Create+Print does not queue and SHIPP 4x6 output is normalized.

---

## Task 9: PS-087 Unfinished Task Closeout

**Files:**
- Inspect: `docs/superpowers/plans/2026-06-05-shipping-purchase-boundary-task-plan.md`
- Inspect: `docs/`
- Inspect: package scripts and guard results.
- Optional Create: `docs/ps-087-unfinished-prepship-v4-closeout.md`

- [ ] **Step 1: Build unfinished-task inventory**

List every active task from this plan with status, commit, verification, and blocker.

- [ ] **Step 2: Close completed tickets**

Only mark tickets 100% if their definition of done is met and safety confirmation is present.

- [ ] **Step 3: Convert remaining work into small follow-ups**

No giant PS-086-style umbrella implementation. Keep each follow-up small, named from the existing board where possible.

- [ ] **Step 4: Verify and report**

Run the relevant final commands from PS-098 plus any PS-084/PS-099-specific guards.

Mark PS-087 100% after the closeout doc/report exists and all remaining open tickets have either a completion report or a concrete blocker.

---

## Reporting Template For Each Ticket At 100%

Use this exact report shape:

```markdown
## <Ticket ID> Completion Report

Status: 100%
Commit(s): <hashes>

Summary:
- <short summary>

Exact files changed:
- `<file>`

What was intentionally not changed:
- <scope exclusions>

Verification:
- `<command>` - PASS

Safety confirmation:
- No real labels/postage purchased.
- No labels voided.
- No live marketplace notifications sent.
- No production shipped/cancelled mutations performed.
- Locked files touched: <list or none>.

Follow-up risks/blockers:
- <risk or none>
```

## Current Recommended Next Step

Do **PS-099 next** for Create+Print separation and SHIPP 4x6 output normalization. After PS-099, close the remaining PS-094/PS-095 compatibility/certification gaps, then use PS-087 as the final unfinished-task closeout.
