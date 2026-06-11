// Vercel function ESM import-closure guard (2026-06-11)
//
// PRODUCTION OUTAGE this prevents: api/carriers/labels.ts returned
//   {"error":"Label function dependencies failed to load","type":"ERR_MODULE_NOT_FOUND"}
// for EVERY direct-carrier label / print-to-queue because ONE module in its
// runtime-dynamic-import tree (src/services/shipping-workflow/address-classification.ts,
// added by PS-127) used an extensionless relative import ('./postal-code').
//
// WHY ONLY THERE: package.json is "type":"module". Vercel inlines each function's STATIC
// import graph with esbuild (lenient resolution — extensionless OK), but modules reached
// via runtime `await import()` (the ensureLabelDeps pattern) are loaded by Node's STRICT
// ESM resolver, which throws ERR_MODULE_NOT_FOUND on extensionless relative specifiers.
// tsconfig moduleResolution "bundler" means typecheck can NEVER catch this. The Render
// backend runs via tsx (lenient), so the same import works there — the breakage is
// Vercel-function-only, at request time, after a green typecheck+build.
//
// INVARIANT: every relative import/export specifier in the transitive closure of every
// api/ function entry must end in .js or .json. Type-only imports (`import type` /
// `export type ... from`) are erased at compile time and exempt.
//
//   node scripts/vercel-fn-esm-import-closure-guard.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';

const ROOT = process.cwd();

// Statement-level matcher so `import type ... from 'x'` can be exempted; also matches
// `export ... from 'x'` re-exports and literal dynamic `import('x')`.
const SPEC_RE =
  /(?:(import|export)\s+(type\s+)?[^;'"]*?from\s*['"](\.\.?\/[^'"]+)['"])|(?:import\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\))/g;

function toFile(fromDir, spec) {
  const base = resolve(fromDir, spec);
  if (spec.endsWith('.js')) {
    for (const c of [base.replace(/\.js$/, '.ts'), base]) if (existsSync(c)) return c;
    return null;
  }
  if (spec.endsWith('.json')) return existsSync(base) ? base : null;
  for (const c of [base + '.ts', base + sep + 'index.ts', base + '.js']) if (existsSync(c)) return c;
  return null;
}

function walk(entry) {
  const seen = new Set();
  const violations = [];
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(SPEC_RE)) {
      const isTypeOnly = Boolean(m[2]);
      const spec = m[3] ?? m[4];
      if (!spec) continue;
      const line = src.slice(0, m.index).split('\n').length;
      const tgt = toFile(dirname(f), spec);
      if (!isTypeOnly && !spec.endsWith('.js') && !spec.endsWith('.json')) {
        const rel = f.slice(ROOT.length + 1).split(sep).join('/');
        violations.push(`${rel}:${line}  '${spec}'`);
      }
      // Type-only imports still traverse: the target file may have runtime imports of its own
      // reachable through OTHER value imports; traversal is cheap and idempotent via `seen`.
      if (tgt && tgt.endsWith('.ts')) stack.push(tgt);
    }
  }
  return { count: seen.size, violations };
}

function apiEntries(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '_lib' && name !== 'node_modules') out.push(...apiEntries(p));
    } else if (name.endsWith('.ts')) {
      out.push(p.slice(ROOT.length + 1).split(sep).join('/'));
    }
  }
  return out;
}

let failures = 0;
for (const entry of apiEntries(join(ROOT, 'api'))) {
  const { count, violations } = walk(entry);
  if (violations.length === 0) {
    console.log(`ok   ${entry} (closure ${count} files)`);
  } else {
    failures += violations.length;
    console.error(`FAIL ${entry} (closure ${count} files) — extensionless relative imports:`);
    for (const v of violations) console.error(`       ${v}`);
  }
}

if (failures > 0) {
  console.error(`\nFAIL vercel-fn-esm-import-closure guard (${failures} violation(s)) — add the .js extension; Node strict ESM throws ERR_MODULE_NOT_FOUND on extensionless relative imports in runtime-dynamic-import trees.`);
  process.exit(1);
}
console.log('\nPASS vercel-fn-esm-import-closure guard');
