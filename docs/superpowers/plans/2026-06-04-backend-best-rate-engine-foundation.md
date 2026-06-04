# Best-Rate Engine Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a flag-gated best-rate engine seam (`legacy` | `v2`) with the v2 per-order compute extracted into a typed, injectable, unit-tested module — defaulting to `legacy` so there is **zero behavior change** when it lands.

**Architecture:** A single `selectBestRate`-style boundary chooses between the existing path (`legacy`, untouched) and a new `v2` engine, based on the runtime setting `best_rate_engine`. The v2 compute is extracted from the existing server-side logic in `src/services/rates-backfill.ts` (which already calls `getRates`, picks the cheapest rate, stamps fingerprint metadata, and upserts `order_overrides.best_rate_json`) into a reusable, dependency-injected function so it can be unit-tested without a DB or live carrier calls. The pure rate-selection logic is extracted so it can later be improved independently ("cheaper rates" spec).

**Tech Stack:** TypeScript (strict, NOT `@ts-nocheck`), Drizzle ORM, the repo's `tsx` guard-script test convention (`scripts/*.ts` with a `check()` helper + `process.exit(1)` on failure).

**Spec:** `docs/superpowers/specs/2026-06-04-backend-best-rate-engine-design.md`

**This is Plan 1 of 4** (see [Roadmap](#roadmap)). It produces working, tested software on its own: a callable, tested v2 compute behind a flag that defaults to `legacy`.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/services/best-rate/types.ts` | Shared types: `BestRateEngine`, `RateLike`, `BestRateRequest`, `GetRatesResult`, `ComputeDeps` | Create |
| `src/services/best-rate/selection.ts` | **Pure** rate selection (`pickCheapestRate`, `pickBestForTier`) — extracted from `rates-backfill.ts` | Create |
| `src/services/best-rate/engine.ts` | `getBestRateEngine()` — reads the `best_rate_engine` setting, defaults `legacy` | Create |
| `src/services/best-rate/v2.ts` | `computeBestRateForOrder(input, deps)` — getRates → stamp metadata → persist; injectable deps | Create |
| `src/services/rates-backfill.ts` | Refactor to import `selection.ts` (DRY) — no behavior change | Modify |
| `scripts/ps-086-bestrate-foundation-guard.ts` | Unit tests for selection, engine dispatch, and v2 compute (injected fakes) | Create |
| `package.json` | Register `test:ps-086-bestrate-foundation` | Modify |

**Constraints:**
- None of the new files use `@ts-nocheck`. They must pass `npm run typecheck` (strict, `noUncheckedIndexedAccess`).
- No test performs a real carrier call, DB write, or label purchase — all use injected fakes.
- `legacy` remains the default `best_rate_engine`. No caller is switched to v2 in this plan.

---

## Task 1: Shared types

**Files:**
- Create: `src/services/best-rate/types.ts`

- [ ] **Step 1: Create the types module**

```typescript
// src/services/best-rate/types.ts

/** Which best-rate engine is active. Selected by the `best_rate_engine` setting. */
export type BestRateEngine = 'legacy' | 'v2';

/** The minimal shape of a carrier rate we select over (matches lib/shipstation Rate). */
export type RateLike = {
  service_code?: string | null;
  shipping_amount: { amount: number };
};

/** Normalized inputs for a single-order rate quote (mirrors getRates' input). */
export type BestRateRequest = {
  weightOz: number;
  toZip: string;
  toState?: string;
  toCity?: string;
  toCountry?: string;
  residential?: boolean;
  dimsL: number;
  dimsW: number;
  dimsH: number;
  storeId: number | null;
  clientId: number | null;
};

/** The subset of getRates' result the compute path consumes. */
export type GetRatesResult = {
  bestRate: Record<string, unknown> | null;
  rates: unknown[];
  cacheKey: string;
  fetchedAt: string;
  cached: boolean;
  carrierDiagnostics: Array<{ status: string }>;
};

/** Injectable dependencies so the compute is unit-testable without DB/carrier IO. */
export type ComputeDeps = {
  getRates: (request: BestRateRequest) => Promise<GetRatesResult>;
  persist: (orderId: number, bestRateJson: Record<string, unknown>, dimsLabel: string) => Promise<void>;
  now: () => Date;
  cacheTtlMs: number;
  eligibilityVersion: string;
};
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0 (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/services/best-rate/types.ts
git commit -m "feat(best-rate): shared types for the engine seam"
```

---

## Task 2: Pure rate selection (extracted)

**Files:**
- Create: `src/services/best-rate/selection.ts`
- Test: `scripts/ps-086-bestrate-foundation-guard.ts` (created here, extended later)
- Modify: `src/services/rates-backfill.ts` (use the extracted module)

- [ ] **Step 1: Write the failing test**

Create `scripts/ps-086-bestrate-foundation-guard.ts`:

```typescript
/**
 * PS-086 Guard — best-rate foundation (selection + engine + v2 compute).
 * Pure logic only; no DB, no carrier IO, never buys a label.
 *   npx tsx scripts/ps-086-bestrate-foundation-guard.ts
 */
import { pickCheapestRate, pickBestForTier } from '../src/services/best-rate/selection.js';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) { failures++; console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`); }
  else { console.log(`ok   ${name}`); }
}

const r = (amount: number, code = 'usps_ground_advantage') =>
  ({ service_code: code, shipping_amount: { amount } });

// pickCheapestRate
check('cheapest of three', pickCheapestRate([r(6.56), r(5.99), r(7.10)])?.shipping_amount.amount, 5.99);
check('empty => null', pickCheapestRate([]), null);
check('single => itself', pickCheapestRate([r(4.2)])?.shipping_amount.amount, 4.2);

// pickBestForTier — standard tier is cheapest overall
check('standard tier cheapest', pickBestForTier([r(9), r(3), r(5)], 'standard')?.shipping_amount.amount, 3);
// overnight tier filters to overnight services, else falls back to all
check('overnight tier filters', pickBestForTier(
  [r(9, 'usps_priority_mail_express'), r(3, 'usps_ground_advantage')], 'overnight'
)?.shipping_amount.amount, 9);
check('overnight tier falls back when none match', pickBestForTier(
  [r(9, 'usps_ground_advantage'), r(3, 'usps_ground_advantage')], 'overnight'
)?.shipping_amount.amount, 3);

if (failures > 0) { console.error(`\nFAIL PS-086 (${failures} failing)`); process.exit(1); }
console.log('\nPASS PS-086 best-rate foundation guard');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/ps-086-bestrate-foundation-guard.ts`
Expected: FAIL — `does not provide an export named 'pickCheapestRate'`

- [ ] **Step 3: Implement the selection module**

Copy the existing tier logic from `src/services/rates-backfill.ts` (`classifyTier`, `pickBestForTier`) into a pure module and add `pickCheapestRate`:

```typescript
// src/services/best-rate/selection.ts
import type { RateLike } from './types.js';

export type ServiceTier = 'overnight' | 'two_day' | 'standard';

export function classifyTier(code?: string | null): ServiceTier {
  if (!code) return 'standard';
  const c = code.toLowerCase();
  if (c.includes('next_day') || c.includes('overnight') || c.includes('priority_mail_express')) return 'overnight';
  if (c.includes('2day') || c.includes('2nd_day') || c.includes('second_day')) return 'two_day';
  return 'standard';
}

export function pickCheapestRate<T extends RateLike>(rates: readonly T[]): T | null {
  if (rates.length === 0) return null;
  return [...rates].sort((a, b) => a.shipping_amount.amount - b.shipping_amount.amount)[0] ?? null;
}

export function pickBestForTier<T extends RateLike>(rates: readonly T[], tier: ServiceTier): T | null {
  const pool = tier === 'standard' ? rates : rates.filter((rate) => classifyTier(rate.service_code) === tier);
  // Fall back to all rates if no match in the requested tier — shipping the
  // cheapest available beats shipping nothing (preserves rates-backfill behavior).
  const candidates = pool.length ? pool : rates;
  return pickCheapestRate(candidates);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/ps-086-bestrate-foundation-guard.ts`
Expected: PASS (all `ok` lines, `PASS PS-086 ...`)

- [ ] **Step 5: Refactor rates-backfill to use the extracted module (DRY, no behavior change)**

In `src/services/rates-backfill.ts`: delete the local `classifyTier` and `pickBestForTier` definitions and import them instead:

```typescript
import { pickBestForTier, classifyTier, type ServiceTier } from './best-rate/selection.js';
```

(Leave every call site identical — the functions are byte-equivalent, just relocated.)

- [ ] **Step 6: Verify typecheck + the existing backfill-related guard still pass**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0
Run: `npm run test:best-rate-dims`
Expected: PASS (backfill behavior unchanged)

- [ ] **Step 7: Commit**

```bash
git add src/services/best-rate/selection.ts src/services/rates-backfill.ts scripts/ps-086-bestrate-foundation-guard.ts
git commit -m "feat(best-rate): extract pure rate selection from rates-backfill"
```

---

## Task 3: Engine selector (flag, default legacy)

**Files:**
- Create: `src/services/best-rate/engine.ts`
- Modify: `scripts/ps-086-bestrate-foundation-guard.ts`

- [ ] **Step 1: Add the failing test**

Append to `scripts/ps-086-bestrate-foundation-guard.ts` (before the `if (failures > 0)` block) and add the import at the top:

```typescript
import { getBestRateEngine } from '../src/services/best-rate/engine.js';
// ... (inside the script body) ...
{
  const read = (value: string | null) => async (_key: string) => value;
  check('null setting => legacy (default)', await getBestRateEngine(read(null)), 'legacy');
  check('"legacy" => legacy', await getBestRateEngine(read('legacy')), 'legacy');
  check('"v2" => v2', await getBestRateEngine(read('v2')), 'v2');
  check('"V2 " (case/space) => v2', await getBestRateEngine(read('V2 ')), 'v2');
  check('garbage => legacy (safe default)', await getBestRateEngine(read('banana')), 'legacy');
}
```

(Note: wrap the script body in an `async` IIFE if it isn't already, so `await` is legal. If converting, end with `})().catch((e) => { console.error(e); process.exit(1); });`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/ps-086-bestrate-foundation-guard.ts`
Expected: FAIL — `does not provide an export named 'getBestRateEngine'`

- [ ] **Step 3: Implement the engine selector**

```typescript
// src/services/best-rate/engine.ts
import { getSetting } from '../settings.js';
import type { BestRateEngine } from './types.js';

export const BEST_RATE_ENGINE_KEY = 'best_rate_engine';

/**
 * Resolve the active best-rate engine. Defaults to 'legacy' for any
 * unset/unknown value so a misconfiguration can never silently route through
 * the new path. `read` is injectable for tests.
 */
export async function getBestRateEngine(
  read: (key: string) => Promise<string | null> = getSetting,
): Promise<BestRateEngine> {
  const raw = (await read(BEST_RATE_ENGINE_KEY))?.trim().toLowerCase();
  return raw === 'v2' ? 'v2' : 'legacy';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/ps-086-bestrate-foundation-guard.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/best-rate/engine.ts scripts/ps-086-bestrate-foundation-guard.ts
git commit -m "feat(best-rate): engine selector flag (defaults to legacy)"
```

---

## Task 4: v2 per-order compute (injectable, extracted)

**Files:**
- Create: `src/services/best-rate/v2.ts`
- Modify: `scripts/ps-086-bestrate-foundation-guard.ts`

- [ ] **Step 1: Add the failing test**

Append to the guard (and import at top):

```typescript
import { computeBestRateForOrder } from '../src/services/best-rate/v2.js';
// ...
{
  const calls: Array<{ orderId: number; json: Record<string, unknown>; dims: string }> = [];
  const deps = {
    getRates: async () => ({
      bestRate: { service_code: 'usps_ground_advantage', shipping_amount: { amount: 6.56 } } as Record<string, unknown>,
      rates: [{}, {}],
      cacheKey: 'fp-123',
      fetchedAt: '2026-06-04T01:00:00.000Z',
      cached: false,
      carrierDiagnostics: [{ status: 'ok' }],
    }),
    persist: async (orderId: number, json: Record<string, unknown>, dims: string) => { calls.push({ orderId, json, dims }); },
    now: () => new Date('2026-06-04T01:00:05.000Z'),
    cacheTtlMs: 6 * 60 * 60 * 1000,
    eligibilityVersion: 'elig-v9',
  };
  const out = await computeBestRateForOrder(
    { orderId: 42, request: { weightOz: 7, toZip: '02451', dimsL: 9, dimsW: 6, dimsH: 3, storeId: 1, clientId: 2 }, dimsLabel: '9x6x3' },
    deps,
  );
  check('compute persisted', out.persisted, true);
  check('persist called once', calls.length, 1);
  check('persist orderId', calls[0]!.orderId, 42);
  check('stamped requestFingerprint = cacheKey', calls[0]!.json.requestFingerprint, 'fp-123');
  check('stamped eligibilityVersion', calls[0]!.json.eligibilityVersion, 'elig-v9');
  check('stamped isComplete (no failed/loading diagnostics)', calls[0]!.json.isComplete, true);

  // No rate found -> no persist, persisted=false.
  const calls2: unknown[] = [];
  const out2 = await computeBestRateForOrder(
    { orderId: 43, request: { weightOz: 7, toZip: '02451', dimsL: 9, dimsW: 6, dimsH: 3, storeId: 1, clientId: 2 }, dimsLabel: '9x6x3' },
    { ...deps, getRates: async () => ({ bestRate: null, rates: [], cacheKey: 'k', fetchedAt: deps.now().toISOString(), cached: false, carrierDiagnostics: [] }), persist: async () => { calls2.push(1); } },
  );
  check('no rate => not persisted', out2.persisted, false);
  check('no rate => persist not called', calls2.length, 0);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/ps-086-bestrate-foundation-guard.ts`
Expected: FAIL — `does not provide an export named 'computeBestRateForOrder'`

- [ ] **Step 3: Implement the v2 compute (metadata stamping mirrors rates-backfill exactly)**

```typescript
// src/services/best-rate/v2.ts
import type { BestRateRequest, ComputeDeps } from './types.js';

export type ComputeInput = {
  orderId: number;
  request: BestRateRequest;
  dimsLabel: string;
};

/**
 * Compute and persist the best rate for ONE order. Extracted from the loop body
 * in rates-backfill.ts so the same logic serves sync/import, input-change, and
 * the ship-day sweep (Plan 2). Dependency-injected for unit testing — no direct
 * DB or carrier IO here. Returns persisted=false when no usable rate is found
 * (caller decides whether to mark unavailable). Metadata stamping is byte-for-
 * byte identical to rates-backfill to preserve equivalence (PS-078 fingerprint).
 */
export async function computeBestRateForOrder(
  input: ComputeInput,
  deps: ComputeDeps,
): Promise<{ persisted: boolean; bestRate: Record<string, unknown> | null }> {
  const result = await deps.getRates(input.request);
  const best = result.bestRate;
  if (!best) return { persisted: false, bestRate: null };

  const bestWithMetadata: Record<string, unknown> = {
    ...best,
    requestFingerprint: result.cacheKey,
    cacheKey: result.cacheKey,
    cacheCreatedAt: result.fetchedAt,
    cacheExpiresAt: new Date(new Date(result.fetchedAt).getTime() + deps.cacheTtlMs).toISOString(),
    eligibilityVersion: deps.eligibilityVersion,
    isComplete: result.carrierDiagnostics.every((d) => d.status !== 'failed' && d.status !== 'loading'),
    rateCount: result.rates.length,
    matchType: result.cached ? 'exact' : 'live',
  };

  await deps.persist(input.orderId, bestWithMetadata, input.dimsLabel);
  return { persisted: true, bestRate: bestWithMetadata };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/ps-086-bestrate-foundation-guard.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/services/best-rate/v2.ts scripts/ps-086-bestrate-foundation-guard.ts
git commit -m "feat(best-rate): injectable v2 per-order compute"
```

---

## Task 5: Register the guard + final verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Register the npm script**

Add to `package.json` scripts (next to the other `test:ps-0xx` entries):

```json
"test:ps-086-bestrate-foundation": "tsx scripts/ps-086-bestrate-foundation-guard.ts",
```

- [ ] **Step 2: Run the full verification suite**

Run: `npm run test:ps-086-bestrate-foundation`
Expected: PASS
Run: `npm run typecheck`
Expected: exit 0
Run: `npm run test:best-rate-dims`
Expected: PASS (proves the rates-backfill refactor is behavior-neutral)

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test(best-rate): register ps-086 foundation guard"
```

---

## Self-Review

- **Spec coverage:** This plan covers the spec's §3 (engine seam + flag), §4 (`types.ts`, `selection.ts`, `engine.ts`, `v2.ts`), and the "equivalence-first" half of §7 (v2 reuses identical metadata stamping; selection extracted byte-equivalent). Deferred to Plans 2–4 (by design): §5 compute triggers/wiring, §6 ship-day refresh, §6/§7 frontend bypass, shadow log (`shadow.ts`), parity guard, and the actual flip. Default stays `legacy` → no behavior change in Plan 1.
- **Placeholder scan:** No TBD/TODO; every code step has complete code; every test step has the assertion and the expected run output.
- **Type consistency:** `BestRateEngine`, `RateLike`, `BestRateRequest`, `GetRatesResult`, `ComputeDeps`, `ComputeInput` are defined in `types.ts`/`v2.ts` and used consistently. `getBestRateEngine(read?)`, `pickCheapestRate`, `pickBestForTier(rates, tier)`, `computeBestRateForOrder(input, deps)` signatures match across tasks and tests.
- **Safety:** no task switches a caller to v2; no test hits DB/carriers/labels.

---

## Roadmap (subsequent plans)

- **Plan 2 — Compute triggers + ship-day refresh:** wire `computeBestRateForOrder` into order sync/import and input-change (save-dims); add the 6 PM CA ship-day sweep worker; refactor `rates-backfill.ts` to call `computeBestRateForOrder` (full DRY).
- **Plan 3 — Shadow mode:** `best-rate/shadow.ts` computes v2 alongside `legacy` and logs old-vs-new disagreements; a report to watch the disagreement rate.
- **Plan 4 — Frontend bypass + parity guard + flip:** under `best_rate_engine = v2`, the Orders table renders `order.bestRate` directly (skip client orchestration); add `ps-085-bestrate-engine-parity`; flip the flag.
