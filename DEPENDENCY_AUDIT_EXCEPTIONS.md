# Dependency Audit — PS-227

Last reviewed: 2026-06-13. Source: `npm audit` on `prepshipv4-stable`.

`npm audit fix` (non-breaking) was applied — it cleared the criticals/highs that had
semver-compatible fixes (hono, react-router, react-router-dom). The remaining
advisories require **breaking** changes; each is triaged below. typecheck +
`build:web` + `test:shipping-roundtrip-certification` are green on the fixed lockfile.

## Enforced gate

`npm run test:dependency-audit` → `npm audit --omit=dev --audit-level=critical`.

Production (non-dev) dependencies must carry **zero CRITICAL** advisories. This is the
hard CI gate — any *new* production critical fails the build. Production highs/moderates
below are accepted, time-boxed exceptions with owners.

## Production exceptions (accepted, tracked)

| Package | Severity | Advisory | Why accepted | Remediation |
|---|---|---|---|---|
| `drizzle-orm <0.45.2` | HIGH | GHSA-gpj5-g38j-94v9 — SQL injection via improperly escaped SQL **identifiers** | PrepShip queries use **static schema identifiers** + **parameterized values** (user input never flows into identifier position), so the documented vector is not reachable in our code. The fix is a **0.36 → 0.45 major jump** (9 minors, breaking) that touches the whole data layer. | **PS-242** — dedicated drizzle-orm major upgrade with full cert + query review. Do NOT bundle into a hardening pass. |
| `uuid <11.1.1` (via `exceljs`) | MODERATE | GHSA-w5hq-g745-h8pq — missing buffer bounds check in v3/v5/v6 when `buf` is provided | `exceljs` uses uuid **v4 without a `buf` argument**, so the vulnerable path is not exercised. The only "fix" downgrades **exceljs to 3.4.0**, which breaks the PS-208/217 billing XLSX export. | Revisit when `exceljs` ships a release depending on a patched `uuid`; do not downgrade. |

## Dev / build-only (NOT in the production bundle)

Vercel serves the static `web/dist` build; these are build/test tooling only and are not
shipped to production runtime. Upgrade opportunistically when their majors land.

| Package | Severity | Note |
|---|---|---|
| `esbuild <=0.28.0` (via `vite`, `@esbuild-kit/*`, `drizzle-kit`) | HIGH | Dev-server request advisory — affects only a running local dev server, not the static prod build. |
| `shell-quote` (via `concurrently`) | CRITICAL | Dev script runner; no production code path. `concurrently@9.2.1` is latest and still pins the vulnerable range. |
| `brace-expansion`, `tsx`, `vite`, `drizzle-kit` | moderate/high | Build/dev toolchain only. |

## Review cadence

Re-run `npm audit` each dependency bump. When `drizzle-orm` (PS-242) and the build
toolchain are upgraded, tighten `test:dependency-audit` from `--audit-level=critical`
to `--audit-level=high`.
