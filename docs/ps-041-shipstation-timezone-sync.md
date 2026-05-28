# PS-041 ShipStation Timezone Sync Runbook

## Root Cause

ShipStation v1 accepts `modifyDateStart` and `createDateStart` as
timezone-less strings. PrepShip previously generated those values by stripping
the `T` and timezone from UTC ISO timestamps, for example:

`2026-05-28T22:00:00.000Z` -> `2026-05-28 22:00:00`

ShipStation v1 interprets that value in the ShipStation account timezone. For
the main account, the effective business timezone is `America/Los_Angeles`, so
the UTC-stripped value can move the sync window about seven hours into the
future during PT business hours. That skipped recent HUGRAB awaiting orders.

PrepShip now formats ShipStation v1 date query params in the account-local
timezone before sending them:

`2026-05-28T22:00:00.000Z` -> `2026-05-28 15:00:00`

## Affected Paths

- Order import `modifyDateStart` through the ShipStation store connector.
- Order sync dedupe/logging query key construction.
- Shipment sync `createDateStart`.

Shipment sync is covered because it used the same UTC-stripping pattern and
ShipStation v1 date semantics.

## Recovery For HUGRAB Orders 1042-1045

Run read-only first:

```bash
npm run shipstation:awaiting:reconcile -- --store-id 378060 --order-numbers=1042,1043,1044,1045 --all-dates
```

If the dry-run reports missing local awaiting orders and DJ approves import,
run the normal order sync with a safe local/PT window or use the existing
ShipStation awaiting reconciliation apply path only for findings it classifies
as safe. Do not apply terminal shipped/cancelled corrections without the
explicit shipped-data override rules in `AGENTS.md`.

This recovery path does not buy postage, create labels, void labels, notify
marketplaces, or mutate shipped/cancelled terminal data by default.

## Verification

- `npm run test:shipstation-sync-window`
- `npm run test:store-connector-source`
- `npm run test:connector-registry`
- `npm run test:shipstation-awaiting-parity`
- `npm run shipstation:awaiting:diff` or the targeted HUGRAB dry-run above
- `npm run status:sync -- --json`
