/**
 * PS-190 guard — structured label-conflict error codes (LABEL_EXISTS / ORDER_NOT_EDITABLE).
 *
 * THE BUG: the backend signalled label conflicts only via human message strings
 * ("Label already exists for this order", "Cannot create label for shipped order")
 * and the FE substring-matched them (isExistingLabelCreateConflict) to decide whether
 * to queue the EXISTING label instead of surfacing an error. Any wording change
 * silently broke the recovery path — and message text is not a contract.
 *
 * THE FIX:
 *   - createLabelV2 stamps `code: 'ORDER_NOT_EDITABLE'` (shipped/cancelled order) and
 *     `code: 'LABEL_EXISTS'` (active label already on the order) on the thrown errors.
 *   - routes/labels.ts handleCreateError returns { error, code, ...details } with the
 *     SAME HTTP statuses as before (400); the legacy message-based mapping stays as a
 *     fallback for older error shapes.
 *   - Both FE transports (ApiRequestError in api.ts, callVercelFunction) carry the
 *     body's `code` onto the thrown error.
 *   - OrdersView.isExistingLabelCreateConflict branches on error.code only — no
 *     substring conflict-detection remains in web/src.
 *
 *   npx tsx scripts/ps-190-label-conflict-codes-guard.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── backend service stamps the codes ─────────────────────────────────────────
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
check('createLabelV2 stamps ORDER_NOT_EDITABLE on shipped/cancelled conflict',
  /Cannot create label for \$\{order\.orderStatus\} order[\s\S]{0,300}err\.code = 'ORDER_NOT_EDITABLE'/.test(labelsService));
check('ORDER_NOT_EDITABLE carries the orderStatus detail',
  /err\.code = 'ORDER_NOT_EDITABLE';\s*\n\s*err\.details = \{ orderStatus: order\.orderStatus \}/.test(labelsService));
check('createLabelV2 stamps LABEL_EXISTS on the active-label conflict',
  /Label already exists for this order[\s\S]{0,300}err\.code = 'LABEL_EXISTS'/.test(labelsService));

// ── route maps the codes (status unchanged: 400) ─────────────────────────────
const labelsRoute = readFileSync('src/routes/labels.ts', 'utf8');
check('route returns { error, code, ...details } for both conflict codes at 400',
  /e\.code === 'LABEL_EXISTS' \|\| e\.code === 'ORDER_NOT_EDITABLE'[\s\S]{0,120}400\)/.test(labelsRoute));
check('legacy message-based status mapping retained as fallback',
  /message === 'Label already exists for this order' \? 400/.test(labelsRoute) &&
  /message\.startsWith\('Cannot create label for'\) \? 400/.test(labelsRoute));

// ── both FE transports carry the code ────────────────────────────────────────
const apiLib = readFileSync('web/src/lib/api.ts', 'utf8');
check('ApiRequestError carries the backend code',
  /code\?: string;/.test(apiLib) && /this\.code = options\.code/.test(apiLib) &&
  /if \(typeof err\?\.code === 'string' && err\.code\) code = err\.code/.test(apiLib));
const vercelFn = readFileSync('web/src/lib/vercelFunction.ts', 'utf8');
check('callVercelFunction carries the backend code',
  /if \(typeof err\?\.code === 'string' && err\.code\) code = err\.code/.test(vercelFn) &&
  /if \(code\) error\.code = code/.test(vercelFn));

// ── FE branches on code; no substring conflict-detection left in web/src ─────
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('isExistingLabelCreateConflict is code-based',
  /isExistingLabelCreateConflict[\s\S]{0,500}code === 'LABEL_EXISTS' \|\| code === 'ORDER_NOT_EDITABLE'/.test(ordersView));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}
const offenders = walk('web/src').filter((f) => {
  const src = readFileSync(f, 'utf8').toLowerCase();
  return src.includes(".includes('cannot create label") || src.includes(".includes('label already exists");
});
check('no substring conflict-detection anywhere in web/src', offenders.length === 0, offenders.join(', '));

if (failures > 0) {
  console.error(`\nFAIL PS-190 label conflict codes guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-190 label conflict codes guard');
