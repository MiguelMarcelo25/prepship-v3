# PS Ticket Hygiene And Frontend Bridge Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the boss feedback by cleaning PS ticket sequencing, documenting/guarding the source-of-truth path, and removing or containing frontend compatibility helpers that look permanent.

**Architecture:** Backend source-of-truth stays authoritative for rates, labels, marketplace confirmation, and money facts. The frontend may keep display-only helpers, but every helper must either consume one backend DTO shape or be explicitly marked as a temporary compatibility bridge with a guard/follow-up. PS sequencing becomes a local tracked artifact so custom work does not reuse PS numbers; this plan must not create, comment on, move, or edit Trello cards.

**Tech Stack:** TypeScript, Node/tsx guard scripts, React/Vite frontend, local PS ledger, Git branches on `prepshipv4-stable`.

---

## File Structure

- Create: `docs/ps-tickets/ps-ledger.md`
  - Owns the PS-number registry for custom/nonstandard cards and recent overlapping PS branches.
  - Records reference URL when useful, branch, commit, status, and whether the number is active/final-review/superseded.
- Create: `scripts/ps-ticket-ledger-guard.ts`
  - Fails when a PS doc/guard/package script uses a number that conflicts with the ledger.
  - Fails when PS-337 is used for both best-rate and eBay certification.
- Modify: `package.json`
  - Add `test:ps-ticket-ledger`.
  - Rename eBay certification command from PS-337 to the next clean number after duplicate review.
- Rename/modify: `docs/ps-tickets/ps-337-ebay-api-testing-certification.md`
  - Move to `ps-339-ebay-api-testing-certification.md`.
  - If repo or read-only board inventory later proves PS-339 is already reserved, stop before code changes, update the ledger with the conflict, and ask DJ for the next PS number.
- Rename/modify: `scripts/ps-337-ebay-api-testing-certification-guard.ts`
  - Move to the same clean number as the eBay doc.
- Inspect/possibly modify: `web/src/components/RateBrowserModal.tsx`
  - Audit remaining local sort/ranking/display bridges.
  - Keep display sorting only if it consumes backend rank fields or is test-mode only.
- Inspect/possibly modify: `web/src/components/Views/orders/best-rate/rate-proof.ts`
  - Collapse multi-shape proof lookup toward one backend DTO shape where safe.
  - Any remaining fallback must be documented as deploy-compat only.
- Inspect/possibly modify: `web/src/components/Views/orders/cells/order-cells.tsx`
  - Confirm test-order and display-only local math cannot leak into real Best Rate / label / queue truth.
- Create or extend: `scripts/ps-340-frontend-bridge-audit-guard.ts`
  - Static guard for helper debt: no new frontend resolver helpers for backend-critical truth, no local Rate Browser best-rate emission, and no untracked multi-shape backend-critical fallback.

---

### Task 1: Freeze PS Numbering And Create Ledger

**Files:**
- Create: `docs/ps-tickets/ps-ledger.md`
- Create: `scripts/ps-ticket-ledger-guard.ts`
- Modify: `package.json`

- [ ] **Step 1: Create a PS ledger with current known conflicts**

Add `docs/ps-tickets/ps-ledger.md` with this initial table:

```markdown
# PrepShip PS Ticket Ledger

This file prevents custom owner tasks and branch-only work from reusing PS numbers.

| PS | Title | Reference | Branch/Commit | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| PS-333 | HUGRAB current-rate source of truth | https://trello.com/c/F8jpCPbp | `origin/codex/ps-333-wrapper-sot-cleanup` | Final Review | Backend rate SOT cleanup. |
| PS-334 | House Rate column / customer Best Rate | https://trello.com/c/qoAI7EQn | `origin/codex/ps-334-house-rate-column-stable` | Final Review | House-rate display split. |
| PS-335 | SOT guard pack / Rate Browser single-flight | https://trello.com/c/QMAdKM9v | `origin/codex/ps-335-sot-guard-pack` | Final Review | Guard pack plus single-flight branch history. |
| PS-336 | Rate Browser loading cleanup | branch-only/current repo guard | `origin/codex/ps-336-rate-browser-loading-cleanup` | Landed/local only | Number already used; do not reuse. |
| PS-337 | Best Rate remove second line | branch-only | `origin/codex/ps-337-best-rate-remove-second-line` | Landed/local only | Number already used; eBay must move off this number. |
| PS-338 | Keep rates visible during browse refresh | branch-only | `origin/codex/ps-338-keep-rates-during-browse-refresh` | Landed/local only | Number already used unless read-only inventory says otherwise. |
| PS-339 | eBay API testing certification | https://trello.com/c/gRogisQ0 | planned renumber from `7c73663a` | Planned/local only | Proposed clean number for the custom eBay owner task; stop if read-only inventory proves PS-339 is already reserved. |
```

- [ ] **Step 2: Add a guard that verifies the eBay certification does not stay PS-337**

Create `scripts/ps-ticket-ledger-guard.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PS ticket ledger guard failed: ${message}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const ledgerPath = 'docs/ps-tickets/ps-ledger.md';
assert(existsSync(ledgerPath), 'docs/ps-tickets/ps-ledger.md must exist');

const ledger = read(ledgerPath);
assert(ledger.includes('| PS-337 | Best Rate remove second line |'), 'ledger must reserve PS-337 for best-rate second-line work');
assert(ledger.includes('| PS-338 | Keep rates visible during browse refresh |'), 'ledger must reserve PS-338 for browse refresh visibility work');
assert(ledger.includes('| PS-339 | eBay API testing certification |'), 'ledger must assign eBay API testing to PS-339');

const packageJson = read('package.json');
assert(!packageJson.includes('test:ps-337-ebay-api-testing-certification'), 'eBay guard must not keep duplicate PS-337 package script');
assert(packageJson.includes('test:ps-339-ebay-api-testing-certification'), 'eBay guard must be registered as PS-339');

assert(!existsSync('docs/ps-tickets/ps-337-ebay-api-testing-certification.md'), 'duplicate PS-337 eBay doc must be renamed');
assert(!existsSync('scripts/ps-337-ebay-api-testing-certification-guard.ts'), 'duplicate PS-337 eBay guard must be renamed');
assert(existsSync('docs/ps-tickets/ps-339-ebay-api-testing-certification.md'), 'PS-339 eBay doc must exist');
assert(existsSync('scripts/ps-339-ebay-api-testing-certification-guard.ts'), 'PS-339 eBay guard must exist');

console.log('PS ticket ledger guard passed');
```

- [ ] **Step 3: Wire the ledger guard**

Modify `package.json` scripts:

```json
"test:ps-ticket-ledger": "tsx scripts/ps-ticket-ledger-guard.ts"
```

- [ ] **Step 4: Run the new guard and confirm it fails before renumbering**

Run:

```powershell
npm run test:ps-ticket-ledger
```

Expected: FAIL because the eBay doc/script are still PS-337.

- [ ] **Step 5: Commit only the failing ledger guard if using TDD split commits**

Run:

```powershell
git add docs/ps-tickets/ps-ledger.md scripts/ps-ticket-ledger-guard.ts package.json
git commit -m "PS ledger guard catches duplicate eBay number"
```

Expected: commit succeeds with a failing guard intentionally if the branch policy allows red commits. If not, defer commit until Task 2 passes.

---

### Task 2: Renumber eBay Certification From PS-337 To PS-339

**Files:**
- Rename: `docs/ps-tickets/ps-337-ebay-api-testing-certification.md` to `docs/ps-tickets/ps-339-ebay-api-testing-certification.md`
- Rename: `scripts/ps-337-ebay-api-testing-certification-guard.ts` to `scripts/ps-339-ebay-api-testing-certification-guard.ts`
- Modify: `package.json`

- [ ] **Step 1: Rename the files**

Run:

```powershell
git mv docs/ps-tickets/ps-337-ebay-api-testing-certification.md docs/ps-tickets/ps-339-ebay-api-testing-certification.md
git mv scripts/ps-337-ebay-api-testing-certification-guard.ts scripts/ps-339-ebay-api-testing-certification-guard.ts
```

- [ ] **Step 2: Replace PS-337 text with PS-339 in the renamed files**

Run:

```powershell
(Get-Content docs/ps-tickets/ps-339-ebay-api-testing-certification.md) -replace 'PS-337', 'PS-339' | Set-Content docs/ps-tickets/ps-339-ebay-api-testing-certification.md
(Get-Content scripts/ps-339-ebay-api-testing-certification-guard.ts) -replace 'PS-337', 'PS-339' | Set-Content scripts/ps-339-ebay-api-testing-certification-guard.ts
(Get-Content package.json) -replace 'test:ps-337-ebay-api-testing-certification', 'test:ps-339-ebay-api-testing-certification' -replace 'scripts/ps-337-ebay-api-testing-certification-guard.ts', 'scripts/ps-339-ebay-api-testing-certification-guard.ts' | Set-Content package.json
```

- [ ] **Step 3: Update the required live approval text to PS-339**

Verify:

```powershell
rg -n "PS-337|ps-337" docs/ps-tickets/ps-339-ebay-api-testing-certification.md scripts/ps-339-ebay-api-testing-certification-guard.ts package.json
```

Expected: no output for the eBay files/package script.

- [ ] **Step 4: Run focused eBay and ledger verification**

Run:

```powershell
npm run test:ps-ticket-ledger
npm run test:ps-339-ebay-api-testing-certification
npm run test:ebay-confirmation:mocked
npm run smoke:marketplace-confirm -- --mock-process-once
```

Expected: all PASS. The smoke output must include `"liveMarketplaceCalled": false`.

- [ ] **Step 5: Run safety verification**

Run:

```powershell
npm run test:ps-268-marketplace-confirmation-residual-audit
npm run test:ps-285-marketplace-confirm-boundary
npm run test:ps-330-controlled-canary-certification
npm run typecheck -- --pretty false
npm run build:web
```

Expected: all PASS.

- [ ] **Step 6: Commit and push the renumber**

Run:

```powershell
git add docs/ps-tickets/ps-ledger.md docs/ps-tickets/ps-339-ebay-api-testing-certification.md scripts/ps-ticket-ledger-guard.ts scripts/ps-339-ebay-api-testing-certification-guard.ts package.json
git commit -m "PS-339 renumber eBay API testing certification"
git push -u origin codex/ps-ticket-hygiene-bridge-cleanup
git push origin HEAD:prepshipv4-stable
```

Expected: feature branch and `prepshipv4-stable` point at the renumber commit.

---

### Task 3: Keep Owner Notes Local Only

**Files:**
- No repo files required.

- [ ] **Step 1: Confirm the no-Trello boundary**

Before executing this task, confirm this boundary in the work notes:

```text
This is DJ's internal task. Do not create Trello cards, add Trello comments, move Trello cards, edit Trello labels, or put this task on Trello.
```

- [ ] **Step 2: Capture the renumber commit SHA**

Run:

```powershell
git rev-parse --short HEAD
```

Expected: one short SHA for the committed PS-339 renumber. Use that exact output in the local owner report below.

- [ ] **Step 3: Prepare a local owner report only**

Write this in the final response or local work log only. Do not post it to Trello.

```text
PS-339 local owner report:
- Converted custom card "eBay is ready for API testing" into PS-339.
- Commit: use the exact short SHA from `git rev-parse --short HEAD`.
- Backend source of truth: src/connectors/store/ebay.ts, src/services/fulfillment/confirmation-payload.ts, src/services/fulfillment/outbox.ts.
- Tests passed: test:ps-ticket-ledger, test:ps-339-ebay-api-testing-certification, test:ebay-confirmation:mocked, smoke:marketplace-confirm -- --mock-process-once, test:ps-268-marketplace-confirmation-residual-audit, test:ps-285-marketplace-confirm-boundary, test:ps-330-controlled-canary-certification, typecheck, build:web.
- Safety: no live eBay calls, no marketplace notifications, no labels/postage, no production order mutation, no shipped/cancelled mutation.
- Live eBay canary remains blocked until exact DJ approval names order, shipment, outbox, action, expected side effect, and rollback plan.
```

- [ ] **Step 4: Park the image card**

The image card is not part of this internal task unless DJ explicitly brings it back into scope. If asked later, handle it as read-only first and keep any report local:

```text
Image card status: parked.
Evidence: DJ said this is his task and not to put it on Trello.
Next: do not inspect, comment, move, or assign a PS number to the image card unless DJ explicitly asks for that card again.
```

---

### Task 4: Audit Rate Browser Local Ranking And Display Bridges

**Files:**
- Create: `docs/ps-tickets/ps-340-ratebrowser-bridge-audit.md`
- Create: `scripts/ps-340-ratebrowser-bridge-audit-guard.ts`
- Modify only if needed: `web/src/components/RateBrowserModal.tsx`
- Modify: `package.json`

- [ ] **Step 1: Create the PS-340 audit doc**

Create `docs/ps-tickets/ps-340-ratebrowser-bridge-audit.md` with this outcome:

```markdown
# PS-340 - Rate Browser frontend bridge audit

Goal: Separate acceptable display-only Rate Browser helpers from backend-critical local authority.

Current known acceptable display-only helpers:
- `sortRateRowsByBackendDisplayRank(...)` may sort visible rows if it consumes backend rank/display facts and never emits/persists Best Rate.
- Test-mode seeded-rate sorting is acceptable only inside `testMode`.
- Manual estimates may display only as not label-safe.

Current known risky bridges:
- Any client-side fallback that emits or persists a cheapest/best rate when backend canonical best is absent.
- Any local markup/rank/eligibility math used for Create Label, Print Queue, Apply Best Rate, or saved Best Rate.
- Any new helper that searches multiple backend object shapes without a removal plan.
```

- [ ] **Step 2: Create a guard for current contract**

Create `scripts/ps-340-ratebrowser-bridge-audit-guard.ts`:

```ts
import { readFileSync } from 'node:fs';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PS-340 Rate Browser bridge audit failed: ${message}`);
}

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');

assert(modal.includes('decideBestRateEmission'), 'Rate Browser must use backend canonical best emission gate');
assert(modal.includes('No backend canonical best for the eligible set'), 'Rate Browser must surface unresolved state instead of emitting local cheapest');
assert(!/emitBestRateResolved\(\s*(?:available|ratesToRank|liveFetchedRates)\.sort/s.test(modal), 'Rate Browser must not emit a locally sorted cheapest rate');
assert(modal.includes('sortRateRowsByBackendDisplayRank'), 'Visible row sorting must stay named as backend-display-rank sorting');
assert(/testMode[\s\S]{0,120}\.sort\(\(a, b\) => a\.shipmentCost \+ a\.otherCost/.test(modal), 'seeded local sort must remain testMode-only');
assert(modal.includes('manual estimate (uninsured') && modal.includes('not label-safe'), 'manual estimates must remain visibly not label-safe');

console.log('PS-340 Rate Browser bridge audit guard passed');
```

- [ ] **Step 3: Wire and run the guard**

Modify `package.json`:

```json
"test:ps-340-ratebrowser-bridge-audit": "tsx scripts/ps-340-ratebrowser-bridge-audit-guard.ts"
```

Run:

```powershell
npm run test:ps-340-ratebrowser-bridge-audit
npm run test:ps-321-ratebrowsermodal-thin-ui
npm run test:rate-source-of-truth
npm run typecheck -- --pretty false
```

Expected: all PASS.

- [ ] **Step 4: Only refactor if the guard finds real authority**

If the guard fails, remove the specific authority path. Do not rewrite the whole modal. Keep changes scoped to one helper/path and rerun the commands from Step 3.

---

### Task 5: Audit Multi-Shape Frontend Compatibility Helpers

**Files:**
- Create: `docs/ps-tickets/ps-341-frontend-compatibility-helper-audit.md`
- Create: `scripts/ps-341-frontend-compatibility-helper-audit-guard.ts`
- Modify only if needed: `web/src/components/Views/orders/best-rate/rate-proof.ts`
- Modify only if needed: `web/src/components/Views/orders/cells/order-cells.tsx`
- Modify: `package.json`

- [ ] **Step 1: Document acceptable vs risky compatibility**

Create `docs/ps-tickets/ps-341-frontend-compatibility-helper-audit.md`:

```markdown
# PS-341 - Frontend compatibility helper audit

Goal: Stop temporary frontend compatibility bridges from becoming permanent backend-truth resolvers.

Acceptable:
- A helper may read legacy object shapes only for display/back-compat.
- A helper may forward backend-issued proof fields.
- A helper may normalize presentation strings.

Not acceptable:
- A helper may not choose official Best Rate.
- A helper may not mint selected-rate proof or rate fingerprints.
- A helper may not compute label purchase eligibility.
- A helper may not calculate authoritative margin/markup/rate money for real orders.

Target cleanup:
- `getSavedBestRateRecord()` must be tracked as compatibility debt until the backend DTO is single-shape.
- `buildSelectedRateProofPayload()` must keep delegating to `selectProofFromCandidates()` and never mint proof.
- `renderBestRateCell()` may use backend money tuples and display fallback only.
```

- [ ] **Step 2: Create a guard that tracks bridge debt explicitly**

Create `scripts/ps-341-frontend-compatibility-helper-audit-guard.ts`:

```ts
import { readFileSync } from 'node:fs';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PS-341 frontend compatibility helper audit failed: ${message}`);
}

const proof = readFileSync('web/src/components/Views/orders/best-rate/rate-proof.ts', 'utf8');
const cells = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');

assert(proof.includes('selectProofFromCandidates'), 'proof payload must delegate to shared backend-issued proof selector');
assert(proof.includes('rateQuoteRefFromCandidates'), 'rate quote refs must delegate to shared selector');
assert(!proof.includes('createHash'), 'frontend proof helper must not hash/mint proof');
assert(!proof.includes('buildShippingRateRequestFingerprint'), 'frontend proof helper must not build backend rate fingerprints');

assert(proof.includes('getSavedBestRateRecord'), 'multi-shape saved best-rate reader must remain visible until removed');
assert(proof.includes('order.bestRate') && proof.includes('shippingModel') && proof.includes('bestRateJson'), 'multi-shape bridge must be tracked explicitly');

assert(cells.includes('getBackendRowMoney'), 'Best Rate cell must consume backend money tuple');
assert(cells.includes('FE-computed markup') && cells.includes('never'), 'Best Rate cell must document no frontend markup fallback');
assert(!/customerRateAmount\s*=|markedAmount\s*=|marginAmount\s*=/.test(cells), 'cells must not assign authoritative rate money values');

console.log('PS-341 frontend compatibility helper audit guard passed');
```

- [ ] **Step 3: Wire and run the guard**

Modify `package.json`:

```json
"test:ps-341-frontend-compatibility-helper-audit": "tsx scripts/ps-341-frontend-compatibility-helper-audit-guard.ts"
```

Run:

```powershell
npm run test:ps-341-frontend-compatibility-helper-audit
npm run test:ps-329-orders-wrapper-sot-cleanup
npm run test:ps-334-house-rate-column
npm run typecheck -- --pretty false
```

Expected: all PASS.

- [ ] **Step 4: Plan removal of the bridge, do not hide it**

If `getSavedBestRateRecord()` still needs all three shapes, leave it visible and guarded. Do not move it to another helper just to quiet the criticism. Create the next implementation ticket only after identifying the backend DTO that can become the single active shape.

---

### Task 6: Final Verification And Report

**Files:**
- Modify if needed: `docs/ps-tickets/ps-ledger.md`

- [ ] **Step 1: Run the final PS cleanup command set**

Run:

```powershell
npm run test:ps-ticket-ledger
npm run test:ps-339-ebay-api-testing-certification
npm run test:ps-340-ratebrowser-bridge-audit
npm run test:ps-341-frontend-compatibility-helper-audit
npm run test:rate-source-of-truth
npm run test:ps-321-ratebrowsermodal-thin-ui
npm run test:ps-329-orders-wrapper-sot-cleanup
npm run test:ps-334-house-rate-column
npm run test:ps-335-sot-guard-pack
npm run typecheck -- --pretty false
npm run build:web
```

Expected: all PASS.

- [ ] **Step 2: Confirm no live side effects**

Report this exact safety statement:

```text
No live eBay calls, no marketplace notifications, no labels/postage, no production order mutations, no shipped/cancelled mutations, no billing mutation, and no inventory mutation were performed.
```

- [ ] **Step 3: Commit final cleanup**

Run:

```powershell
git status --short --branch
git add docs/ps-tickets/ps-ledger.md docs/ps-tickets/ps-339-ebay-api-testing-certification.md docs/ps-tickets/ps-340-ratebrowser-bridge-audit.md docs/ps-tickets/ps-341-frontend-compatibility-helper-audit.md scripts/ps-ticket-ledger-guard.ts scripts/ps-339-ebay-api-testing-certification-guard.ts scripts/ps-340-ratebrowser-bridge-audit-guard.ts scripts/ps-341-frontend-compatibility-helper-audit-guard.ts package.json
git commit -m "PS cleanup ticket ledger and bridge audit guards"
git push -u origin codex/ps-ticket-hygiene-bridge-cleanup
git push origin HEAD:prepshipv4-stable
```

Expected: only intended files are staged/committed. Existing scratch files stay untracked.

---

## Self-Review

Spec coverage:
- Boss concern "too many compatibility helpers": covered by Tasks 4 and 5.
- Boss concern "Rate Browser still has local price/rank math": covered by Task 4.
- Boss concern "board/card sequencing is messy": covered by Tasks 1, 2, and 3.
- Safety/source-of-truth rules: covered by Tasks 4, 5, and 6.

Placeholder scan:
- No task depends on undefined scope.
- The image card remains intentionally blocked until attachment details are readable.

Type consistency:
- PS-339 is reserved for eBay after PS-337/PS-338 collision review.
- PS-340 and PS-341 are planned cleanup tickets; if read-only local/board inventory proves either number is already reserved, update `docs/ps-tickets/ps-ledger.md` before implementation.
