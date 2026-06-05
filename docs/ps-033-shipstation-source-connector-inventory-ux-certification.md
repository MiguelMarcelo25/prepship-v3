# PS-033 - ShipStation Source Connector and Inventory UX Certification

Task ID: PS-033

Title: Certify ShipStation Source Connector Flow and Fix Inventory UX Certification Blockers

Assignee: `<@714064895963955211>`

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Status: Certified on 2026-05-28 after the approved Walmart marketplace reconciliation and full-site verification pass.

## Summary

PS-033 is complete for the source connector and Inventory UX certification scope.

The ShipStation source connector path is configured and working through the StoreConnector boundary. Static source guards pass, live ShipStation awaiting checks return `200 OK`, and the dry-run reconciliation now classifies all remaining mismatches without any new safe auto-reconciliation candidates.

The Inventory UX blockers called out by the original task are fixed and verified:

- Stock Levels table body scrolls within laptop-sized viewports.
- Receive Inventory SKU picker aligns to the input width and preserves full selected-client lookup behavior.
- Mobile Inventory SKU picker/browser flow is stable.
- Full-site certification passes.

## Connector / Order Flow Certification Result

Current source model:

```text
PrepShip core
-> StoreConnector source/orchestrator
-> ShipStation StoreConnector
-> ShipStation API
-> normalized order values
-> PrepShip persistence/UI
```

Verification evidence:

- `npm run test:store-connector-source` passed.
- `npm run test:connector-registry` passed.
- `npm run test:shipstation-awaiting-parity` passed.
- `npm run shipstation:awaiting:diff` reached ShipStation successfully with `200 OK` responses for configured stores.
- Latest dry run fetched `15` live ShipStation awaiting rows: `10` from main stores and `5` from the KF Goods scoped check.

Answer to "Is the source connector configured, and are ShipStation awaiting orders flowing correctly?":

Yes. The connector source guard, registry guard, ShipStation parity guard, and live awaiting dry-run all confirm the ShipStation source connector path is configured and functional. Remaining mismatches are classified data-state exceptions, not evidence that the connector flow is broken.

## Reconciliation Status

An earlier dry run identified Walmart order `200014894429696` / local id `947584` as a safe reconciliation candidate because Walmart Marketplace reported terminal status `Delivered`.

After DJ provided the exact shipped-data override phrase, the single approved candidate was applied:

| Order | Local id | From | To | Evidence | Result |
| --- | ---: | --- | --- | --- | --- |
| `200014894429696` | `947584` | `awaiting_shipment` | `shipped` | Walmart Marketplace `Delivered` | Updated |

Post-apply verification:

- `npm run marketplace:reconcile -- --provider walmart --order-number 200014894429696` returned `candidates=0`.
- Database read-back confirmed local id `947584` is now `shipped`.
- `Walmart Store` awaiting count dropped from `6` to `5`.

Latest ShipStation awaiting dry-run classification:

| Category | Count | Notes |
| --- | ---: | --- |
| Safe automated candidates | `0` | The prior Walmart `Delivered` candidate was applied. |
| Test fixture/data cleanup candidates | `25` | `TESTING-*` non-live rows missing from live ShipStation awaiting. |
| Needs confirmation | `5` | Direct Walmart rows missing from ShipStation awaiting; these require marketplace/human confirmation before changing. |
| Blocked by shipped/cancelled lockdown | `1` | Order `1010` / local id `1138616` is local `shipped` while ShipStation/raw says `awaiting_shipment` with latest shipment voided. Do not mutate without a separate explicit approval. |

Remaining direct Walmart rows needing confirmation:

- `200014665323555`
- `200014732389095`
- `200014639540604`
- `200014795784623`
- `200014792256437`

## Inventory UX Fixes Certified

The current code already contains the PS-033 Inventory UX fixes:

- Stock Levels uses a constrained scrollable table shell, with the pagination/footer remaining usable in laptop-sized viewports.
- Receive Inventory SKU lookup loads the full selected-client inventory set, including inactive rows, without the old small default cap.
- Receive Inventory SKU dropdown aligns to the input width and escapes worksheet overflow clipping.
- Mobile Inventory combobox/search/select flows remain stable in browser certification.

## Commands Run

| Command | Result |
| --- | --- |
| `npm run test:store-connector-source` | Pass |
| `npm run test:connector-registry` | Pass |
| `npm run test:shipstation-awaiting-parity` | Pass |
| `npm run shipstation:awaiting:diff` | Pass, dry-run only |
| `npm run test:inventory-default-view` | Pass |
| `npm run test:receive-sku-picker` | Pass |
| `npm run test:inventory-ux:browser` | Pass, 4 browser tests |
| `npm run typecheck` | Pass |
| `npm run build:web` | Pass |
| `npm run test:full-site-certification` | Pass |

`npm run test:full-site-certification` included typecheck, web build, site action guard, API contracts, label URL guard, print queue invalid-label guard, workflow browser certification, Orders UX browser tests, Inventory UX browser tests, maintenance gate browser tests, and frontend failure-state guards.

## Remaining Approvals / Follow-Ups

- No remaining safe automated ShipStation/Walmart status candidate exists after the approved reconciliation.
- The `25` `TESTING-*` rows can be handled as separate test fixture cleanup if desired.
- The `5` direct Walmart awaiting rows should remain awaiting until marketplace or human confirmation proves they are terminal.
- Order `1010` / local id `1138616` remains blocked by shipped/cancelled lockdown and needs separate explicit approval before any mutation.

## Safety Confirmation

No code path weakened auth/RBAC, client/store scope, connector source-of-truth, secret redaction, label safety, or shipped/cancelled protections.

No real labels were created, no postage was purchased, no live marketplace notifications were sent, no secrets or PII were added to docs, and no cancelled orders were touched.

The only live status mutation performed during PS-033 closeout was the exact approved Walmart Marketplace reconciliation of order `200014894429696` / local id `947584` from `awaiting_shipment` to `shipped`, after DJ typed the shipped-data override phrase.
