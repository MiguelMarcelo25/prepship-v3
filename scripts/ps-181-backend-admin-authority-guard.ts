/**
 * PS-181 guard — admin identity is backend-owned; no FE admin-email hardcodes.
 *
 * THE BUG: OrdersView kept its own ADMIN_EMAILS set ('admin@drprepper.com') and compared
 * the Supabase auth email client-side to decide admin UI visibility — a second, drifting
 * copy of the backend's canonical admin list (src/lib/admin-emails.ts). Adding an admin
 * required editing two files; a typo in one produced inconsistent admin powers.
 *
 * THE FIX: the FE asks GET /users/me (already served by routes/users.ts via the canonical
 * isAdminEmail) and reads `isAdmin`. The FE never hardcodes admin emails; it defaults to
 * non-admin until the backend answers. Server-side enforcement of admin-only routes is
 * unchanged — this flag only gates display.
 *
 * Pins:
 *   1. No 'ADMIN_EMAILS' anywhere in web/src (recursive sweep).
 *   2. OrdersView loads callerIsAdmin from GET /users/me (backend verdict, === true).
 *   3. Backend /users/me still answers isAdmin via the canonical isAdminEmail.
 *   4. Behavioral: isAdminEmail accepts the canonical admin, rejects others/null,
 *      and is case/whitespace tolerant.
 *
 *   npx tsx scripts/ps-181-backend-admin-authority-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAdminEmail } from '../src/lib/admin-emails';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. recursive sweep: no ADMIN_EMAILS hardcode anywhere in web/src ─────────
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry)) out.push(p);
  }
  return out;
}
const offenders = walk('web/src').filter((f) => readFileSync(f, 'utf8').includes('ADMIN_EMAILS'));
check('no ADMIN_EMAILS hardcode anywhere in web/src', offenders.length === 0, offenders.join(', '));

// ── 2. OrdersView reads the backend verdict ──────────────────────────────────
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('OrdersView loads callerIsAdmin from GET /users/me',
  /api\.get[^\n]*'\/users\/me'/.test(ordersView));
check('OrdersView accepts only the backend boolean verdict (isAdmin === true)',
  /setCallerIsAdmin\(res\.isAdmin === true\)/.test(ordersView));
check('OrdersView no longer compares auth emails for admin visibility',
  !/authUser\?\.email && ADMIN_EMAILS/.test(ordersView));

// ── 3. backend /users/me stays on the canonical owner ────────────────────────
const usersRoute = readFileSync('src/routes/users.ts', 'utf8');
check('backend /users/me answers isAdmin via the canonical isAdminEmail',
  /app\.get\('\/me'[\s\S]{0,400}isAdmin: isAdminEmail\(email\)/.test(usersRoute));

// ── 4. behavioral: canonical owner semantics ─────────────────────────────────
check('canonical admin accepted', isAdminEmail('admin@drprepper.com') === true);
check('case/whitespace tolerant', isAdminEmail('  Admin@DrPrepper.com ') === true);
check('non-admin rejected', isAdminEmail('worker@drprepper.com') === false);
check('null/empty rejected', isAdminEmail(null) === false && isAdminEmail('') === false);

if (failures > 0) {
  console.error(`\nFAIL PS-181 backend admin authority guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-181 backend admin authority guard');
