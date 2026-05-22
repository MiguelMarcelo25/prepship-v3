# Backend Connectivity Map

This document records the current PrepShip V4 backend wiring so future cleanup can be done safely.

## Runtime Owners

PrepShip currently uses two backend surfaces:

- **Render / Hono API** in `src/main.ts` and `src/routes/*`
  - Owns core app data and operational workflows.
  - Mounted behind Supabase JWT auth for protected routes.
- **Vercel `/api/*` functions** in `api/*`
  - Own direct carrier/store integration edges that are still separated from the Render API.
  - Used by settings/integration UI through `callVercelFunction()`.

This split is intentional today. Do not collapse it in a broad refactor without a dedicated migration task and production verification.

## Render / Hono Route Groups

Core route groups mounted in `src/main.ts`:

- `/orders`
- `/shipments`
- `/packages`
- `/clients`
- `/rates`
- `/labels`
- `/sync`
- `/inventory`
- `/locations`
- `/settings`
- `/billing`
- `/manifests`
- `/analysis`
- `/dashboard`
- `/print-queue`
- `/parent-skus`
- `/products`
- `/init`
- `/admin`
- `/carrier-accounts`
- `/carriers`
- `/users`
- `/worker`
- `/observability`
- `/cron`
- `/health`

## Vercel API Function Groups

Integration functions under `api/*` include:

- `/api/carrier-accounts`
- `/api/store-accounts`
- `/api/carriers/rates`
- `/api/carriers/labels`
- `/api/carriers/verify`
- `/api/carriers/validate-address`
- `/api/carriers/walmart/orders`
- `/api/carriers/walmart/fees`
- `/api/carriers/ebay/orders`
- `/api/oauth/ebay/callback`
- `/api/cron/sync-walmart-fees`

## Connector Status

Connector registration is not the same thing as full live implementation.

- Live or live-path-backed:
  - `shipstation`
  - `walmart`
  - `walmart_shipping`
  - `shipp`
  - `easypost`
  - `ups`
- Registered stubs:
  - `ebay`
  - `shopify`
  - `amazon`
- Blocked pending external API contract:
  - `tiktok_shop`
  - `woocommerce`

Before presenting a connector as production-ready, check `src/connectors/implementation-status.ts` and the actual route/function that performs the work.

## Guardrail

Run this local guard after endpoint or integration UI changes:

```powershell
npm run guard:backend-connectivity
```

The guard checks that frontend API calls have a matching Render/Hono route or Vercel `/api/*` function file. It is intentionally read-only and does not call production services.

## Low-Risk Cleanup Policy

Safe cleanup:

- Add docs that clarify route ownership.
- Add read-only guards.
- Remove stale comments in unlocked files.
- Split large frontend files only with GitNexus impact analysis and existing guards.

Avoid without a dedicated task:

- Moving Vercel `/api/*` functions into Render.
- Changing label, shipment, shipped, or cancelled mutation behavior.
- Changing sync worker ownership/env semantics.
- Replacing connector credential resolution.
