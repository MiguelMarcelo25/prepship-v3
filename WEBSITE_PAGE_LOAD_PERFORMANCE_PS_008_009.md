# PS-008 / PS-009: Website Page Load Performance Hardening

@Lawrence

You are working in the PrepShip V4 repo.

- Repo: `https://github.com/drprepperusa-org/prepship-v4.git`
- Branch: `prepshipv4-stable`
- Task IDs: `PS-008` and `PS-009`
- Task title: `Website Page Load Performance Hardening`
- Priority: High

## Context

DJ asked why the PrepShip website is loading slowly and requested a deep dive. The investigation found that the slowdown is mostly frontend payload and boot cost, not one isolated backend API issue.

Treat `PS-009` as the explicit root-cause checklist and acceptance expansion for `PS-008`, not as a separate duplicate implementation track.

This task is frontend/build-performance focused.

Do not weaken auth, RBAC, client/store scope, secret redaction, shipped/cancelled lockdown, or existing production safeguards. Respect `AGENTS.md`. Do not modify shipped/cancelled logic. Do not make backend data mutations.

## Confirmed Repo Findings

- `tailwind.config.ts` still has the broad `ACCENT_PALETTES` safelist.
- `web/src/components/Views/DashboardView.tsx` still directly imports `recharts`.
- `web/src/components/Views/DashboardView.tsx` still has the broad startup pattern:

```ts
await Promise.allSettled([clientsPromise, corePromise, inventoryPromise, analysisPromise])
```

- No existing `PS-008` or `PS-009` Markdown handoff file was found in the repo.

## Measured Root Causes

1. Oversized global CSS bundle
   - Current global CSS bundle is about `3.77 MB` raw / `271 KB` gzip.
   - Built CSS contains roughly `37k` rules.
   - Root cause appears to be the broad Tailwind safelist in `tailwind.config.ts` for old dynamic theme/sidebar color variants.
   - The safelist generates many unused classes for `from-*`, `via-*`, `to-*`, `shadow-*`, `ring-*`, `border-*`, `bg-*`, and `text-*`.
   - Because global CSS loads on every page, this affects login, initial shell, and all major views.

2. Heavy chart bundle
   - Dashboard and Analysis pull Recharts through a shared `charts-*` chunk around `416 KB` raw / `112 KB` gzip.
   - Charts should not block Dashboard first paint.

3. Large lazy page chunks
   - Known large chunks from the performance pass:
     - `OrdersView`: about `198 KB` raw
     - `Home`: about `188 KB` raw
     - `InventoryView`: about `123 KB` raw
     - `SettingsView`: about `115 KB` raw
     - `DashboardView`: about `92 KB` raw

4. Dashboard starts too much work upfront
   - Dashboard currently starts trends, counts, summaries, inventory risk, top SKUs, analysis data, and clients early.
   - Critical KPI/summary data should load first.
   - Chart, trend, inventory, and table-heavy panels should defer until after first paint.

## Files To Read First

- `AGENTS.md`
- `vite.config.ts`
- `tailwind.config.ts`
- `package.json`
- `web/src/main.tsx`
- `web/src/App.tsx`
- `web/src/Home.tsx`
- `web/src/components/Views/DashboardView.tsx`
- `web/src/components/Views/AnalysisView.tsx`
- `scripts/orders-startup-requests-guard.mjs`
- `scripts/analysis-table-first-guard.mjs`
- `scripts/analysis-lazy-table-guard.mjs`
- `scripts/inventory-default-view-guard.mjs`

## Implementation Checklist

### A. Reduce Global CSS Bundle Size

- Remove or aggressively narrow the broad `ACCENT_PALETTES` / class-pattern safelist in `tailwind.config.ts`.
- Replace it with no safelist if possible, or with a tiny explicit safelist only for actual runtime classes.
- Replace remaining runtime dynamic Tailwind color class construction with semantic classes or CSS variables.
- Check whether inactive old design/sidebar variants are being scanned by Tailwind, especially:
  - `web/src/pages/Clients_variants/`
  - `web/src/components/Sidebar/`
- If inactive design variant files are not active app code, move them outside Tailwind's content scan path or convert preserved references to `.md` / `.txt`.
- Do not delete useful reference code unless it is clearly unused.

Suggested tiny safelist shape:

```ts
const RUNTIME_SAFE_CLASSES = [
  'bg-brand',
  'bg-brand/10',
  'bg-brand/20',
  'text-brand',
  'border-brand',
  'ring-brand/30',
  'from-brand',
  'to-brand',
]
```

### B. Add Bundle Regression Guards

Create `scripts/web-bundle-budget-guard.mjs`.

The guard must:

- Find the built `web/dist/assets/index-*.css` asset.
- Print raw and gzip sizes.
- Fail if global CSS raw size is greater than `1,000,000` bytes.
- Fail if global CSS gzip size is greater than `110,000` bytes.
- Fail if generated gradient rules exceed `300`.

Add this package script:

```json
"test:web-bundle-budget": "npm run build:web && node scripts/web-bundle-budget-guard.mjs"
```

Create `scripts/tailwind-safelist-guard.mjs`.

The guard must fail if broad safelist generation is reintroduced, including:

- `ACCENT_PALETTES`
- `(bg|text|ring|border|shadow|from|via|to)`
- `(50|100|200|300|400|500|600|700|800|900)`

Add this package script:

```json
"test:tailwind-safelist": "node scripts/tailwind-safelist-guard.mjs"
```

### C. Lazy-Load Dashboard Charts

- Move Recharts imports out of `DashboardView.tsx`.
- Create a lazy chart component, likely:
  - `web/src/components/Views/DashboardCharts.tsx`
- `DashboardView.tsx` must lazy-load the chart component with `React.lazy` and `Suspense`.
- KPI/table/shell content should render before chart panels require Recharts.

Expected pattern:

```tsx
const DashboardCharts = lazy(() => import('./DashboardCharts'))
```

Add `scripts/dashboard-chart-lazy-guard.mjs`.

The guard must verify:

- `DashboardView.tsx` does not directly import `recharts`.
- `DashboardView.tsx` lazy-loads `DashboardCharts`.
- `DashboardCharts.tsx` owns the `recharts` imports.
- `package.json` exposes `test:dashboard-chart-lazy`.

Add this package script:

```json
"test:dashboard-chart-lazy": "node scripts/dashboard-chart-lazy-guard.mjs"
```

### D. Improve Dashboard First Paint

- Add a helper such as `scheduleDashboardNonCriticalWork` using `requestIdleCallback` with a `setTimeout` fallback.
- Load critical KPI/summary data first.
- Defer trend/chart/inventory/top-SKU/table-heavy data until after first paint.
- Preserve current stale-load and load-sequence protections.
- Preserve panel-level skeleton and error states.
- Do not block `setLoading(false)` on every non-critical panel.

Add `scripts/dashboard-first-paint-guard.mjs`.

The guard must verify:

- `DashboardView.tsx` contains `scheduleDashboardNonCriticalWork`.
- The initial load no longer awaits `Promise.allSettled([clientsPromise, corePromise, inventoryPromise, analysisPromise])`.
- Metrics can finish separately from heavier panels.
- `package.json` exposes `test:dashboard-first-paint`.

Add this package script:

```json
"test:dashboard-first-paint": "node scripts/dashboard-first-paint-guard.mjs"
```

### E. Inspect Large Page Chunks

Review `OrdersView`, `Home`, `InventoryView`, `SettingsView`, and `DashboardView` for obvious heavy imports, unused UI variants, large inline helpers, or panels that can be split safely.

Make targeted splits only where they reduce first interaction cost. Do not do broad refactors in this task.

### F. Keep Existing Startup Protections Passing

Do not regress:

- Orders support data lazy fetches.
- Orders delayed exact total count.
- Orders delayed sync polling.
- Analysis table-first load.
- Analysis lazy table split.
- Inventory active-only default.

## Verification Commands

Run these before handoff:

```powershell
npm run build:web
npm run test:web-bundle-budget
npm run test:tailwind-safelist
npm run test:dashboard-chart-lazy
npm run test:dashboard-first-paint
npm run test:orders-startup-requests
npm run test:analysis-table-first
npm run test:analysis-lazy-table
npm run test:inventory-default-view
npm run typecheck
```

Report the new sizes for:

- Global CSS raw/gzip
- `charts-*` chunk raw/gzip
- `Home` chunk
- `OrdersView` chunk
- `DashboardView` chunk
- `InventoryView` chunk
- `SettingsView` chunk

## Definition Of Done

- Global CSS raw size is below `1 MB`.
- Global CSS gzip size is below `110 KB`.
- Broad Tailwind color/gradient/shadow safelist is removed or replaced with a tiny explicit safelist.
- Bundle budget guard exists and passes.
- Tailwind safelist regression guard exists and passes.
- Dashboard no longer directly imports Recharts.
- Dashboard charts lazy-load behind `Suspense`.
- Dashboard first paint is not blocked by every chart/table/inventory request.
- Existing Orders / Analysis / Inventory startup guards still pass.
- `npm run typecheck` passes.
- `npm run build:web` passes.
- No auth/RBAC/scope/secret/shipped-lockdown behavior is weakened.

## Return Format

When done, reply with:

- Summary of root causes fixed
- Summary of files changed
- Before/after build sizes
- Tests run with pass/fail results
- Any deferred performance items with reason
- Any browser smoke findings if tested manually
