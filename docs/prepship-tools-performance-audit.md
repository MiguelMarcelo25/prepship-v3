# PrepShip Tools Performance Audit

This checklist is the operating standard for keeping PrepShip tool pages fast and quiet under normal navigation. Chrome extension console errors are external and are not counted as PrepShip-owned failures.

## Shared Rules

- Shared data uses cache/dedupe: clients, stores, packages, status, counts, billing config, package prices, and package usage.
- Default shared-data policy is `staleTime: 5m`, `gcTime: 30m`, no refetch on window focus.
- Status reads are non-blocking. `/sync/status` and `/worker/status` must never block tool page paint.
- Sidebar counts are cached and deduped. Hidden browser tabs do not poll.
- Page initial paint should fetch only data visible on that page or tab.
- Heavy reporting must come from `/dashboard/*`, `order_items`, `analytics_cache`, or reporting read models first.
- Explicit user actions may run heavy work: generate invoices, fetch rates, exports, imports, sync buttons.

## Page Checklist

| Tool | Initial Load | Repeated Polling | Heavy Work Rule | Current Notes |
|---|---|---|---|---|
| Dashboard | Load aggregate panels independently | No aggressive status polling | Use `/dashboard/*` and reporting metrics first | Inventory risk is non-blocking and cached client-side |
| Inventory | Load paginated stock rows first | No background package fetch unless Receive tab opens | Sold/velocity/restock should use metrics, not live scans | Stock table no longer waits on client dropdown load |
| Clients | Load client list only | No polling | Mutations invalidate clients/stores/counts only | Shared client reads are cached |
| Packages | Load package library first | No polling | Usage/ledger/history lazy or delayed | Low-stock reuses package rows; usage summary delays after paint |
| Rate Shop | User-triggered rates only | No automatic rate refresh loops | External carrier failures show controlled UI | Shared carrier/store data should stay cached |
| Analysis | Load charts/table separately | No polling | Use `order_items`/reporting metrics | Client names come from shared cached clients |
| Settings | Load visible section first | No polling | Carrier/env checks only on visible sections | Column prefs are cached and non-blocking |
| Billing | Load config/package prices/summary separately | No polling | Summary reads generated outputs/read models first | Billing config, prices, and summary are cached |
| Manifests | Load manifest list first | No polling | Details/print/export are user-triggered | Avoid unrelated packages/orders fetch on first paint |

## Browser Verification

1. Open each page directly and from the sidebar.
2. Keep DevTools Network open for at least 2 minutes.
3. Confirm no repeated PrepShip-owned timeout warnings.
4. Confirm hidden tab pauses status/count polling.
5. Confirm page-specific data loads before optional side panels or summaries.
6. Confirm Render logs do not show repeated 499s or 30s duplicate reads.

## Production Priority

1. Dashboard
2. Inventory
3. Billing
4. Packages
5. Clients
6. Analysis
7. Rate Shop
8. Settings
9. Manifests
