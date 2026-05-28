# PrepShip Testing Coverage Standard

Every PrepShip fix must choose the highest meaningful safe verification layer.
Static checks are useful, but they do not replace workflow proof when the user
impact is an operator workflow or provider boundary.

## Applicability Checklist

- UI/operator workflow change: add or update browser E2E/workflow coverage.
- API/service contract change: add or update API/integration coverage.
- Provider boundary change: add a focused provider-contract guard and a
  read-only live-path or dry-run reconciliation command when credentials are
  available.
- Dangerous live mutation: use read-only/dry-run proof by default, and require
  explicit DJ approval before any apply/write mode.
- Data repair/backfill: provide a dry-run-first command that reports exactly
  what would change before any mutation.

## ShipStation Date/Sync Standard

ShipStation v1 date query params must be tested at the query-window level.
A passing fix must prove that a UTC watermark such as
`2026-05-28T22:00:00.000Z` is sent to ShipStation v1 as the account-local
wall-clock value `2026-05-28 15:00:00`, not as stripped UTC text.

## Forbidden Verification Shortcuts

- Do not mark provider-boundary fixes complete using only typecheck.
- Do not mark UI workflow fixes complete using only static guards.
- Do not silently skip live-path checks when credentials are missing; report
  the missing environment requirement clearly.
- Do not run label/postage/marketplace/shipped-terminal mutations as part of
  automated tests.
