# Operator (DJ) action items — consolidated

Everything that needs **you** (not code) across the in-flight work, gathered in one
place. Updated 2026-06-13. Nothing here blocks further ticket development — these are
deploy/dashboard/verification steps you can batch later.

## 🔴 Do soon — security (the code shipped; these complete it)

| Item | Where | Why | From |
|---|---|---|---|
| **Ban / disable the 3 `client_user` accounts** (clients 2/10, 4, 3 — two are gmail) or confirm they're inert contacts | Supabase → Auth → Users | Interim stop-gap for the cross-tenant exploit until the deployed fix is confirmed live | PS-233 |
| **Set `STRICT_JWT_CLAIMS=true`** | Render env + Vercel env | Makes the whole API validate JWT issuer/audience (the two credential functions already force it; this covers the rest) | PS-230 |
| **Enable "leaked password protection"** | Supabase → Auth → Policies | HaveIBeenPwned check — currently disabled | PS-232 |

## 🟡 Verify on the deployed app (live checks code can't do)

| Check | How | From |
|---|---|---|
| Cross-tenant blocked | Staging two-token test: `client_user(A)` GET `/shipments/:id` + POST `/labels` for client B → expect **404/403** | PS-233/240 |
| Anon PostgREST still denied | anon-key read of `clients`/`orders` via `…supabase.co/rest/v1/…` → returns `[]` | PS-228 |
| Security headers present | `curl -I` the deployed document URL → X-Frame-Options/nosniff/Referrer/Permissions/CSP-Report-Only | PS-226 |
| Void Label UI | Open a shipped order w/ an active label → Void row enabled only when voidable; run one confirm-void → flips to Awaiting only on provider success | PS-219 |
| Box size + cost in exports | Generate a Billing PDF + XLSX → Box Size / Box Cost columns populate | PS-217 |

## 🟢 Deploy / env notes

- Pushing `prepshipv4-stable` auto-deploys Render (CI-gated: typecheck+build+cert) + Vercel (via mirror).
- Migrations **0044** (audit_log), **0045** (revoke public grants), **0046** (pgboss search_path) are all **idempotent + additive** — safe whenever they run.
- PS-207: deploy → click **Update Billing** → work the review queue (box resolution).
- PS-215: enable the shipped-display classifier env flags per the runbook.

## 📦 Data you'll provide (unblocks PS-222 / PS-223)

- **PS-222:** real `unit_cost` + `client_package_prices` list (the seeding script ingests it). Catalog structure (factory-box $0, bubble mailer, 8x8x2 typo fix) lands in code.
- **PS-223:** the 53-SKU classification (`classification.json`) + packing rules 1–9 (`guidelines.json`). The rule engine + dry-run land in code; seeding waits on this.

## ⏸️ Parked / operational (DJ-gated, from earlier tracks)

- PS-200 cutover: eBay OAuth RuName, business-day flip, admin/cron migration, S5 `api/` deletion.
- PS-205 (HUGRAB package-facts eyeball), PS-206 (Rate Browser eyeball), PS-202 (direct-label test-mode + canary), PS-199 (Walmart PO live check).
- Awaiting-sync Stage 4: purge ~25 test fixtures from awaiting (parked pending live test).
- **PS-242** (new): drizzle-orm 0.36→0.45 major upgrade — its own ticket (SQL-identifier advisory; not reachable today).

## 🔭 Coming (after I build them this session)

- PS-239 marketplace fee/profit: set fee rules in Settings, eyeball the two columns on Awaiting/Shipped.
- PS-241 rate-browser: canary a HUGRAB order → clean fan-out; killed provider → single error badge.
