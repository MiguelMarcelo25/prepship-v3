# PS-318 Shipping Workflow Certification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Certify PrepShip's shipping workflow matrix over existing backend owners without creating a second workflow owner.

**Architecture:** Add an offline PS-318 guard that composes existing pure backend owners and static source pins, then document the store/provider matrix and caveats. No production code or locked shipped/cancelled files should change unless the guard proves a concrete unowned gap.

**Tech Stack:** TypeScript guard scripts via `tsx`, existing PrepShip backend services, Trello PS workflow, npm scripts, Markdown docs.

---

### Task 1: Add Red Guard

**Files:**
- Create: `scripts/ps-318-shipping-workflow-certification-guard.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the failing guard**

Create `scripts/ps-318-shipping-workflow-certification-guard.ts` with checks for:
- missing `docs/ps-tickets/ps-318-shipping-workflow-certification-matrix.md`;
- missing package script;
- required predecessor command wiring;
- pure behavior for shipping safety, queue route planning, marketplace identity, and outbox lifecycle plans;
- static source pins for labels, print queue, outbox, frontend no-buy, shipments, billing, and inventory.

- [ ] **Step 2: Wire npm script**

Add:

```json
"test:ps-318-shipping-workflow-certification": "tsx scripts/ps-318-shipping-workflow-certification-guard.ts"
```

- [ ] **Step 3: Verify RED**

Run:

```bash
npm run test:ps-318-shipping-workflow-certification
```

Expected: FAIL only because the PS-318 matrix doc is missing, after fixing any brittle scanner assumptions.

### Task 2: Add Matrix Documentation

**Files:**
- Create: `docs/ps-tickets/ps-318-shipping-workflow-certification-matrix.md`

- [ ] **Step 1: Document backend owner map**

Document owners for Awaiting row, Best Rate / proof, Create + Print, Print Queue, shipment snapshot, shipped row display, fulfillment outbox / marketplace confirmation lifecycle, and billing/inventory side effects.

- [ ] **Step 2: Document store/provider matrix**

Include rows for:
- HUGRAB / ShipStation-source;
- Walmart-source;
- eBay / eBay Shipping or ShipStation-synced eBay;
- Direct carrier / Shipp / EasyPost;
- not_applicable manual/internal;
- not_supported connector/upstream-id gaps.

- [ ] **Step 3: Document safety and caveats**

State fixture/mock/offline only, live canary required for live labels/postage/marketplace notifications, and no customer PII or shipped/cancelled mutation.

### Task 3: Verify Green And Commit

**Files:**
- `scripts/ps-318-shipping-workflow-certification-guard.ts`
- `docs/ps-tickets/ps-318-shipping-workflow-certification-matrix.md`
- `docs/superpowers/plans/2026-06-26-ps-318-shipping-workflow-certification.md`
- `package.json`

- [ ] **Step 1: Run focused green check**

```bash
npm run test:ps-318-shipping-workflow-certification
```

Expected: PASS.

- [ ] **Step 2: Run reused guards**

```bash
npm run guard:shipping-certification
npm run test:ps-085-shipping-workflow
npm run test:ps-098-shipping-purchase-boundary
npm run test:ps-300-backend-shipping-authority
npm run test:ps-303-print-queue-authority
npm run test:ps-317-fe-buy-anti-regression
npm run test:direct-carrier-labels
npm run test:direct-carrier-queue-route
npm run test:walmart-confirmation:payload
npm run test:ps-285-marketplace-confirm-boundary
npm run test:ps-064-confirmation-outbox
```

Expected: PASS.

- [ ] **Step 3: Run build checks**

```bash
npm run typecheck
npm run build:web
git diff --check
```

Expected: PASS, allowing only existing Windows line-ending warnings.

- [ ] **Step 4: Commit locally**

```bash
git add package.json scripts/ps-318-shipping-workflow-certification-guard.ts docs/ps-tickets/ps-318-shipping-workflow-certification-matrix.md docs/superpowers/plans/2026-06-26-ps-318-shipping-workflow-certification.md
git commit -m "PS-318 certify shipping workflow matrix"
```

## Safety

No real labels, postage, voids, marketplace notifications, production mutations,
customer PII, or shipped/cancelled mutations. Do not edit locked shipped/cancelled files.
