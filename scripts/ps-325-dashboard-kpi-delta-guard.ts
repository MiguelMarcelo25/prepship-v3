/**
 * PS-325 (slice 2) guard — the Dashboard "vs prior period" delta DEFINITION is backend-owned.
 *
 * The +X% / -X% chips on the KPI cards (Last 7 Days, {range}-Day, Total Revenue) and the SKU table's
 * "vs Prior 30 Days" change% column used to be computed by a relativePct() DEFINED inside DashboardView
 * — the frontend owned the rule for what a relative change means (the +100% growth-from-zero floor, the
 * both-empty 0%, the signed formula). This guard pins the cleanup:
 *  1. src/lib/kpi-delta.ts is the single owner of relativePct, with the three branch literals verbatim.
 *  2. DashboardView IMPORTS relativePct from that owner.
 *  3. Anti-vacuous: DashboardView no longer DEFINES `function relativePct(` locally.
 *  4. The import is actually consumed — >= 4 relativePct( call sites remain (3 KPI cards + 1 SKU column),
 *     so quietly dropping a consumer is caught too.
 *
 * Offline/static only.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// 1. Canonical owner ----------------------------------------------------------------------------
const owner = read('src/lib/kpi-delta.ts');
check('kpi-delta owns relativePct with the three branch literals byte-identical',
  /export function relativePct/.test(owner) &&
  /if \(prior <= 0 && current <= 0\) return 0/.test(owner) &&
  /if \(prior <= 0\) return 100/.test(owner) &&
  /return \(\(current - prior\) \/ prior\) \* 100/.test(owner));

// 2-4. DashboardView delegates -----------------------------------------------------------------
const dash = read('web/src/components/Views/DashboardView.tsx');
check('DashboardView imports relativePct from the canonical owner',
  /import \{[^}]*\brelativePct\b[^}]*\} from ['"]\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/kpi-delta['"]/.test(dash));
check('DashboardView no longer DEFINES relativePct locally (anti-vacuous)',
  !/function relativePct\(/.test(dash));
const callSites = (dash.match(/relativePct\(/g) ?? []).length;
check('the delta consumers still call the shared relativePct (>= 4 call sites: 3 KPI cards + SKU column)',
  callSites >= 4, { callSites });

if (failures > 0) {
  console.error(`\nPS-325 dashboard KPI delta guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-325 dashboard KPI delta guard passed.');
