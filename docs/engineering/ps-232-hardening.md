# PS-232 — low-severity hardening bundle

Status 2026-06-13. Six low-severity items from the security review; 5 are code/
migration (shipped here), 1 is a Supabase dashboard toggle (DJ).

| # | Item | Where | Status |
|---|---|---|---|
| 1 | **Supabase "leaked password protection"** (HaveIBeenPwned) — currently DISABLED (advisor `auth_leaked_password_protection`) | Supabase → Auth → Policies | **DJ ops** — one toggle in the Supabase dashboard (no code) |
| 2 | pgboss SECURITY DEFINER functions had a mutable `search_path` (advisor `function_search_path_mutable`) | `drizzle/0046_pgboss_search_path.sql` | ✅ migration (idempotent; pins `search_path = pgboss, pg_catalog`) |
| 3 | Serverless env-error echoed missing-var **names** in the 500 body | `src/lib/env.ts` | ✅ generic message; names logged server-side only |
| 4 | Worker logged full **stack traces** to stderr unconditionally | `src/worker.ts` | ✅ gated behind `WORKER_DEBUG_STACKS=1` (name+message always) |
| 5 | `/distinct-skus` read query params with **no zod** validation | `src/routes/orders.ts` | ✅ `zValidator('query', …)` (coerced IDs, bounded strings; still parameterized SQL) |
| 6 | `/cron/*` sync body had **no size cap** (webhooks have 1MB) | `src/routes/cron.ts` | ✅ 64 KB cap before parse (oversize → safe defaults) |

Guard: `scripts/ps-232-hardening-bundle-guard.ts` (`test:ps-232-hardening-bundle`)
pins items 2–6. Item 1 is verified in the Supabase dashboard.
