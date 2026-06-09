/**
 * PS-158 — dead component removal guard.
 *
 * web/src/components/PackageModal.tsx was a fully orphaned modal (0 import sites anywhere in web/src).
 * It was deleted. This guard prevents it (or an import of it) from silently reappearing, and asserts
 * the live package-editing UI (PackagesView + its real modals) is unaffected.
 *
 * Offline / pure: readFileSync + readdir only. No DB, no network.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── (1) The dead file stays deleted ──
check('web/src/components/PackageModal.tsx is deleted (not resurrected)',
  !existsSync('web/src/components/PackageModal.tsx'));

// ── (2) Nothing imports the deleted component ──
function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) { if (entry !== 'node_modules') walk(p, out); }
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
}
const files: string[] = [];
walk('web/src', files);
// Match an import that resolves specifically to the PackageModal component file (not PackagesView,
// PackagesDataTable, PackageModalProps types, etc.). The deleted module path ends in /PackageModal.
const importers = files.filter((f) => {
  const src = readFileSync(f, 'utf8');
  return /from\s+['"][^'"]*\/PackageModal['"]/.test(src) ||
         /import\s+['"][^'"]*\/PackageModal['"]/.test(src);
});
check('no module imports the deleted ./PackageModal component', importers.length === 0,
  importers.length ? `importers: ${importers.join(', ')}` : undefined);

// ── (3) The live package UI is intact (sanity: PackagesView still present) ──
check('live PackagesView.tsx still present (package editing UI unaffected)',
  existsSync('web/src/components/Views/PackagesView.tsx'));

if (failures > 0) {
  console.error(`\nFAIL PS-158 dead-component guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-158 dead-component guard');
