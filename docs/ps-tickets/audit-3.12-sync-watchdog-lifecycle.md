# Audit 3.12 — sync watchdog lifecycle placement

## Architecture placement / source-of-truth gate

- **Business rule/workflow:** Sync recovery must act once per observed failure,
  restart a worker only when its heartbeat proves it stale, identify unhealthy
  ShipStation accounts separately, resume wide awaiting-order backlogs, and
  distinguish an upstream fulfillment from PrepShip's own confirmation echo.
- **Canonical owners:** `shipment-sync-watchdog.ts` owns health recovery and
  restart admission. `order-sync.ts` owns per-account/store awaiting pagination.
  `store-order-import.ts` owns persistence reconciliation between translated
  provider fulfillment and the canonical local `shipments` fact.
- **Unsafe/duplicated owners removed or constrained:** Timer and the two cron
  recovery methods no longer race through process-local cooldown observations. Render
  escalation cannot treat a fresh worker as unverifiable/dead. Awaiting imports
  no longer restart every wide pass at page 1. Shopify remains a translator and
  does not decide whether a fulfillment was created by PrepShip.
- **Earliest imperfect-data entry:** Independent watchdog drivers can observe
  the same stale snapshot concurrently. A wide ShipStation awaiting result can
  exhaust the worker budget before later pages. Shopify can echo a fulfillment
  created by PrepShip after marketplace confirmation.
- **Callers that delegate:** The process timer plus cron GET and POST recovery
  drivers use one transaction advisory-locked tick; `/sync/status` remains a
  side-effect-free observer. Awaiting
  account/store targets read and persist their backend settings cursor. All
  store connectors continue to persist through `upsertNormalizedStoreOrders`,
  which reads active outbound shipment truth before accepting an external latch.
- **Wrapper/resolver logic deleted or forbidden:** No watchdog driver may bypass
  the shared advisory lock; no escalation may bypass the heartbeat gate; no
  awaiting loop may hard-code page 1; and no connector adapter may become the
  authority for local-vs-external fulfillment ownership.
- **Frontend role:** None. Existing status consumers display backend diagnostics
  and own no sync health, recovery, restart, cursor, or fulfillment decision.
- **Backend boundary proof:** `test:audit-sync-watchdog-lifecycle` behaviorally
  proves heartbeat gating, per-account unhealthy verdicts, and cursor advance,
  probe-retention, and reset behavior. Static checks pin shared advisory locking,
  serialized health/cooldown reads, read-only status reporting, per-account
  alert persistence/logging, durable cursor wiring, thin Shopify translation,
  and active-shipment latch suppression. It is mandatory in the source-of-truth
  guard pack.
- **Workflow proof:** PS-361, PS-397, PS-409, PS-265 run-budget/staleness,
  advisory-lock, connector/import, Shopify, lockdown, strict typecheck,
  production build, and the full SOT pack are required.

Per user override `unlock shipped data` on 2026-07-14, the only protected logic
changed is `src/services/store-order-import.ts`: an incoming provider-shipped
echo now reads the linked active outbound shipment and refuses/clears the
one-way `externally_shipped` latch. Terminal status preservation is unchanged;
no existing shipment is rewritten or deleted. Offline verification performs no
database mutation, provider call, real label/postage purchase, marketplace
notification, inventory change, or production shipped/cancelled mutation.
