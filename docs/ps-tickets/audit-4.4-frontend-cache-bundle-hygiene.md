# Audit 4.4 — frontend cache and bundle hygiene

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** Identical client-list GETs must share
  one TanStack cache entry per endpoint, while frontend navigation and assets must
  avoid avoidable JavaScript and serialized-animation cost.
- **Canonical backend/domain/read-model/policy owner:** Backend client visibility
  remains owned by `/clients?activeOnly=true` and
  `/clients?includeInactive=true`. Frontend cache identity is owned by
  `client-query.ts`; the shared `query-client.ts` instance owns cache lifecycle.
  `web-bundle-budget-guard.mjs` owns built-asset size enforcement.
- **Current duplicated/unsafe owners:** Client rows entered `cachedReads` plus
  multiple TanStack keys. Four files imported a second icon library, six carrier
  marks were compiled as TSX, remaining `mode="wait"` gates serialized swaps, and
  the bundle guard enforced CSS only.
- **Where bad/stale/incomplete data can enter:** Duplicate cache entries are
  created at each view query declaration and the legacy API adapter. Inline SVG
  paths and mixed icon packages enter at module import time; oversized chunks
  enter at the Vite build output boundary.
- **Callers that must delegate to the owner:** Hooks, Invoice, Picklist, Clients,
  Analysis, Inventory, Marketplace Fees, and the legacy client adapter consume
  the shared endpoint keys (with Analysis retaining its guard-pinned inline GET
  literal). CarrierBadge and integration settings load static logo assets. The
  build guard inspects every emitted JavaScript chunk.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** No client GET
  may use `cachedSafe` or a view-specific key. No `react-icons`, inline carrier
  logo component, or `AnimatePresence mode="wait"` may return. Views must not
  create a second client-response cache.
- **Frontend role: display/action only; no authoritative business logic:** Client
  active/inactive scope still comes from explicit backend query parameters. The
  frontend owns only request dedupe, presentation assets, and build budgets.
- **Backend boundary tests required:** None; no backend behavior changes. The
  focused audit guard pins explicit endpoint parameters and shared query keys.
- **Workflow/UI proof required:** Focused frontend hygiene guard, strict
  typecheck, production build, per-chunk bundle budget, existing client-scope and
  view guards, and the SOT guard pack.

No shipped/cancelled or other protected path is touched. Verification is offline
and performs no database write, provider call, label/postage purchase,
marketplace notification, inventory change, or production mutation.
