# Imported Handler and DB Pool Boundary Audit

## Audit 3.4 Result

All eight modules under `src/lib/imported-handlers` compile under strict
TypeScript without `@ts-nocheck`. Node-style request/response compatibility and
JSON parsing are owned by `src/lib/node-handler.ts`; handlers consume that typed
boundary instead of maintaining local body readers.

Credential normalization remains in `src/lib/credential-accounts.ts`, credential
persistence remains in `src/services/credential-accounts.ts`, and schema
readiness remains in `src/services/credential-account-schema.ts`. HTTP handlers
perform auth, validate intent, and delegate to those owners.

## Connection Ownership

Normal API, OAuth, credential verification, marketplace import, Walmart fee, and
maintenance paths use the process-wide postgres.js pool from `src/db/client.ts`.
They do not construct or close request-owned pools.

The remaining postgres.js constructors are explicit isolation boundaries:

- `src/routes/health.ts`: independently bounded readiness probes.
- `src/lib/advisory-session-lock.ts`: coordination transactions isolated from app traffic.
- `src/services/sync-lane-lock.ts`: lane locks must not starve the app pool.
- `src/services/shipstation-carrier-account-snapshot-worker.ts`: reserved session advisory lock.

## Imperfect-Data Boundary

Legacy marketplace credentials previously moved from `carrier_accounts` to
`store_accounts` during the first store-account request. Migration
`drizzle/0063_credential_account_cutover.sql` now owns that idempotent data
cutover. Render and legacy request handlers no longer migrate credential rows.

Deploy order is mandatory: apply migrations through `0063`, then deploy the
API/worker code. No provider call or live credential migration is part of the
code verification workflow.

## Proof

- `npm run test:audit-imported-handler-boundary`
- `npm run test:credential-accounts`
- `npm run typecheck`
- `npm run build:web`
- mandatory SOT guard pack and marketplace/credential guards
