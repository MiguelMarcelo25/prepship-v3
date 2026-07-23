# PS-464 current-head architecture boundary report

This report describes the reviewed boundary inventory at implementation base
`4784cb60b6d6958147cff3790d926525b2a6f4d7`. The executable guard prints the Git `HEAD` it is
actually checking, so CI and Final Review evidence always report the tested revision rather than
trusting a stale prose SHA.

## Current inventory

| Boundary | Current count | Exact reviewed ownership |
|---|---:|---|
| Frontend imports into backend-private `src/**` | 17 imports / 12 files | PS-320, PS-433, PS-441 |
| Route-local `db`/`tx` writes | 80 calls / 11 route files | PS-441, PS-454, PS-458, PS-462 |
| High-risk frontend semantic sites | 26 sites | PS-313, PS-408, PS-415, PS-433, PS-441, PS-444, PS-462 |

The exact path, target or route endpoint, count, reason, and PS owner for every reviewed exception
live in `scripts/ps-464-architecture-boundary-policy.ts`. The guard prints that full mapping on
every successful run. An exception is not a generic suppression: a new path/site fails, an
increased count fails, and removed debt leaves a stale entry that also fails until the policy is
shrunk.

Compared with the PS-464 card's older baseline (20 direct imports in 14 frontend files), the
current head has already reduced that boundary to 17 imports in 12 files. The lower current count
is the ratchet; the card baseline is not restored.

## Executable evidence

Run:

```text
npm run test:ps-464-architecture-boundaries
```

The command is offline/static. It parses the current frontend and route trees, verifies all
ratchets and ownership metadata, and runs fail/pass fixtures for renamed high-risk authority,
backend-private imports, route-local writes, display/DTO work, provider adapter translation, and
thin route delegation. It is the first command in `scripts/sot-guard-pack.mjs`, which CI executes
before typecheck and the frontend build.

## Placement and safety

- Canonical enforcement owner: `scripts/ps-464-architecture-boundary-guard.ts`.
- Reviewed debt owner: `scripts/ps-464-architecture-boundary-policy.ts`.
- Imperfect data enters when a frontend import, frontend authority implementation, or route-local
  persistence call is added without a canonical backend owner.
- Callers delegate by importing only public contracts and by routing mutations through services,
  read models, policies, adapters, and persistence in that direction.
- No runtime source, production data, provider, label, postage, notification, inventory, billing,
  auth, or shipped/cancelled behavior is changed by PS-464.
