#!/usr/bin/env node
// Atom extractor. Walks a repo, emits one JSONL per atom to stdout.
//
// Usage:
//   node scripts/parity/extract.mjs <repoRoot> <side> > parity/<side>-atoms.jsonl
//   side = "v2" | "v4"
//
// Atoms are: routes, services, schema tables + columns, DTOs, constants,
// hooks, contexts, apiClient methods, CSS classes, ShipStation calls,
// and frontend View feature atoms (columns/filters/modals/actions).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Project, SyntaxKind } from 'ts-morph';
import {
  v2ModuleForPath,
  v4ModuleForPath,
  normalizeRouteId,
  normalizeServiceId,
  normalizeSchemaId,
  normalizeDtoId,
  normalizeConstantId,
  normalizeHookId,
  normalizeApiClientId,
  normalizeViewAtomId,
  normalizeCssClassId,
  normalizeSsCallId,
} from './rules.mjs';

const [, , repoRoot, side] = process.argv;
if (!repoRoot || !side || !['v2', 'v4'].includes(side)) {
  console.error('Usage: extract.mjs <repoRoot> <v2|v4>');
  process.exit(1);
}

const moduleFor = side === 'v2' ? v2ModuleForPath : v4ModuleForPath;

// ── File walk ───────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' ||
        name === 'build' || name === 'coverage' || name === '.next') continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(repoRoot);
const tsFiles = files.filter((f) => /\.tsx?$/.test(f));
const cssFiles = files.filter((f) => /\.css$/.test(f));

// ── ts-morph project (no real compile — just AST) ───────────────────────────
const project = new Project({
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
  useInMemoryFileSystem: false,
  // No compilerOptions — avoid triggering the TS type checker, which chokes
  // on string jsx options and is unnecessary for AST-only extraction.
});

// Cheaper "is this node exported" check that doesn't call into the type checker.
// isExported() does — it walks the symbol table — which requires a parsed
// tsconfig + fully resolved program. We only need to know if the syntactic
// `export` keyword is present on the declaration (or its parent statement).
function hasExportModifier(node) {
  if (typeof node.getModifiers === 'function') {
    for (const m of node.getModifiers()) {
      if (m.getKind() === SyntaxKind.ExportKeyword) return true;
    }
  }
  // VariableDeclarations live inside a VariableStatement — check the parent
  const parent = node.getParent?.();
  const stmt = parent?.getParent?.();
  if (stmt && typeof stmt.getModifiers === 'function') {
    for (const m of stmt.getModifiers()) {
      if (m.getKind() === SyntaxKind.ExportKeyword) return true;
    }
  }
  return false;
}

function emit(atom) {
  process.stdout.write(JSON.stringify(atom) + '\n');
}

function locOf(node) {
  const sf = node.getSourceFile();
  const start = node.getStart();
  const { line } = sf.getLineAndColumnAtPos(start);
  return {
    file: relative(repoRoot, sf.getFilePath()).split(sep).join('/'),
    line,
  };
}

// ── Extractor: TS/TSX files ─────────────────────────────────────────────────
let routeCount = 0, serviceCount = 0, schemaCount = 0, dtoCount = 0;
let constCount = 0, hookCount = 0, apiClientCount = 0, viewAtomCount = 0;
let ssCallCount = 0, contextCount = 0;

// Determine the Hono mount prefix for a v4 route file. `src/routes/orders.ts`
// mounts at /orders; paths inside the file like `/` or `/:id` need to be
// prepended with the mount prefix so route IDs match v2 (which bakes the
// full path into each route declaration).
function v4MountPrefix(rel) {
  const m = rel.match(/src\/routes\/([a-z-]+)\.ts$/);
  if (!m) return '';
  const name = m[1];
  // Special-case: print-queue's prefix is /print-queue
  if (name === 'init' || name === 'health' || name === 'admin' || name === 'cron') {
    return '/' + name;
  }
  return '/' + name;
}

for (const abs of tsFiles) {
  const rel = relative(repoRoot, abs).split(sep).join('/');
  const mod = moduleFor(rel);
  if (!mod) continue;

  let sf;
  try {
    sf = project.addSourceFileAtPath(abs);
  } catch {
    continue;
  }

  const mountPrefix = side === 'v4' ? v4MountPrefix(rel) : '';

  // ── Routes ────────────────────────────────────────────────────────────────
  // v2 uses `route({method, path, handler})` + `jsonRoute(...)` in app/router.ts
  // and a flat RouteDef[] array per module's api/routes.ts. Look for either.
  // v4 uses Hono: app.get|post|put|patch|delete(path, handler).
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const expr = call.getExpression();
    const text = expr.getText();

    // Hono-style: app.METHOD('/path', handler)
    const honoMatch = text.match(/^[a-zA-Z_$][\w$]*\.(get|post|put|patch|delete)$/);
    if (honoMatch && call.getArguments().length >= 1) {
      const pathArg = call.getArguments()[0];
      const path = literalString(pathArg);
      if (path != null) {
        // Prepend mount prefix for v4 (file-name → URL-prefix).
        // `/` becomes the mount root; `/:id` becomes `/<mount>/:id`.
        const fullPath = mountPrefix
          ? (path === '/' ? mountPrefix : mountPrefix + path)
          : path;
        const id = normalizeRouteId(honoMatch[1], fullPath);
        emit({
          module: mod, category: 'route', id,
          location: locOf(call),
          signature: `${honoMatch[1].toUpperCase()} ${fullPath}`,
          metadata: { method: honoMatch[1].toUpperCase(), path: fullPath },
        });
        routeCount++;
      }
    }

    // v2 route/jsonRoute helper — supports BOTH shapes:
    //   route({method, path, handler}) — object-arg
    //   route("GET", "/api/orders", handler) — positional (what v2 actually uses)
    const name = text.split('.').pop();
    if ((name === 'route' || name === 'jsonRoute') && call.getArguments().length >= 1) {
      const first = call.getArguments()[0];
      if (first.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const obj = first.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        const method = readStringProp(obj, 'method');
        const path = readStringProp(obj, 'path');
        if (method && path) {
          const id = normalizeRouteId(method, path);
          emit({
            module: mod, category: 'route', id,
            location: locOf(call),
            signature: `${method.toUpperCase()} ${path}`,
            metadata: { method: method.toUpperCase(), path },
          });
          routeCount++;
        }
      } else if (call.getArguments().length >= 2) {
        // Positional shape: route("METHOD", "/path", handler)
        const method = literalString(call.getArguments()[0]);
        const path = literalString(call.getArguments()[1]);
        if (method && path && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/i.test(method)) {
          const id = normalizeRouteId(method, path);
          emit({
            module: mod, category: 'route', id,
            location: locOf(call),
            signature: `${method.toUpperCase()} ${path}`,
            metadata: { method: method.toUpperCase(), path },
          });
          routeCount++;
        }
      }
    }

    // ShipStation calls: v4 uses ssRequest/ssV1Request; v2 uses the
    // ShipStationClient class — methods called `.v1Request('/path')`,
    // `.v2Request('/path')`, `.request('/path')`, or `.fetch('/path')`.
    const ssName = text.split('.').pop();
    if (/^(ssRequest|ssV1Request|ssFetch|shipstationFetch|shipstationRequest|ssCall|v1Request|v2Request)$/.test(ssName)
        && call.getArguments().length >= 1) {
      const pathArg = call.getArguments()[0];
      const path = literalString(pathArg);
      if (path != null) {
        const id = 'ss:' + normalizeSsCallId(path);
        emit({
          module: '_shipstation', category: 'ss-call', id,
          location: locOf(call),
          signature: `ShipStation ${path}`,
          metadata: { path, caller: ssName },
        });
        ssCallCount++;
      }
    }
  }

  // ── ApiClient class methods (v2 uses `export class ApiClient { ... }`) ────
  if (/api\/client\.ts$/.test(rel) || /v2-apiClient\.ts$/.test(rel)) {
    for (const cls of sf.getClasses()) {
      if (!/^(Api|V2|V4)?Client$/.test(cls.getName() ?? '')) continue;
      for (const method of cls.getMethods()) {
        const mname = method.getName();
        if (!mname) continue;
        emit({
          module: '_config', category: 'api-client',
          id: 'apiclient:' + normalizeApiClientId(mname),
          location: locOf(method),
          signature: `apiClient.${mname}()`,
          metadata: { method: mname, file: rel },
        });
        apiClientCount++;
      }
    }
  }

  // ── Exported consts (constants + apiClient + simple services) ─────────────
  for (const decl of sf.getVariableDeclarations()) {
    if (!hasExportModifier(decl)) continue;
    const name = decl.getName();
    const init = decl.getInitializer();
    if (!init) continue;
    const initKind = init.getKind();

    // Drizzle pgTable — schema atoms
    if (initKind === SyntaxKind.CallExpression) {
      const initCall = init;
      const callee = initCall.getExpression().getText();
      if (callee === 'pgTable' || callee.endsWith('.pgTable')) {
        const args = initCall.getArguments();
        const tableName = literalString(args[0]);
        if (tableName) {
          emit({
            module: mod, category: 'schema', id: normalizeSchemaId(tableName),
            location: locOf(decl), signature: `table ${tableName}`,
            metadata: { table: tableName },
          });
          schemaCount++;
          // Columns (2nd arg — ObjectLiteralExpression of column defs)
          if (args[1]?.getKind() === SyntaxKind.ObjectLiteralExpression) {
            const colsObj = args[1];
            for (const p of colsObj.getProperties()) {
              if (p.getKind() === SyntaxKind.PropertyAssignment) {
                const colName = p.getName();
                const valText = p.getInitializer()?.getText() ?? '';
                const colType = (valText.match(/^([a-z]+)\(/i)?.[1]) ?? 'unknown';
                emit({
                  module: mod, category: 'schema',
                  id: normalizeSchemaId(tableName, colName),
                  location: locOf(p),
                  signature: `column ${tableName}.${colName} ${colType}`,
                  metadata: { table: tableName, column: colName, type: colType,
                    notNull: /\.notNull\(\)/.test(valText),
                    primaryKey: /\.primaryKey\(\)/.test(valText),
                    hasDefault: /\.default/.test(valText),
                  },
                });
                schemaCount++;
              }
            }
          }
        }
        continue;
      }

      // apiClient: const apiClient = { method: ..., ... } — detect object of fn exprs
    }

    // Primitive / object const — constant atom (in config files) OR apiClient
    const filePath = rel;
    const isConfig = /prepship-config|carrier-accounts|worker-config|app-config/.test(filePath);
    if (isConfig) {
      emit({
        module: mod, category: 'constant', id: 'const:' + normalizeConstantId(name),
        location: locOf(decl), signature: `export const ${name}`,
        metadata: { name, file: filePath },
      });
      constCount++;
    }

    // apiClient object literal — each method is an atom
    const isApiClient = /api\/client\.ts|v2-apiClient\.ts/.test(filePath) &&
                        (name === 'apiClient' || name === 'client');
    if (isApiClient && initKind === SyntaxKind.ObjectLiteralExpression) {
      const obj = init;
      for (const p of obj.getProperties()) {
        if (p.getKind() === SyntaxKind.PropertyAssignment ||
            p.getKind() === SyntaxKind.MethodDeclaration ||
            p.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
          const methodName = p.getName?.() ?? 'unknown';
          emit({
            module: '_config', category: 'api-client',
            id: 'apiclient:' + normalizeApiClientId(methodName),
            location: locOf(p),
            signature: `apiClient.${methodName}()`,
            metadata: { method: methodName },
          });
          apiClientCount++;
        }
      }
    }
  }

  // ── Exported functions (services + hooks) ─────────────────────────────────
  for (const fn of sf.getFunctions()) {
    if (!hasExportModifier(fn)) continue;
    const name = fn.getName();
    if (!name) continue;
    const isHook = /hooks\//.test(rel) && name.startsWith('use');
    const isService = /services\/|service\.ts$/.test(rel) ||
                      /\/application\//.test(rel);
    if (isHook) {
      emit({
        module: mod, category: 'hook', id: 'hook:' + normalizeHookId(name),
        location: locOf(fn), signature: `${name}(...)`,
        metadata: { name, file: rel },
      });
      hookCount++;
    } else if (isService) {
      emit({
        module: mod, category: 'service', id: 'service:' + normalizeServiceId(name),
        location: locOf(fn), signature: `${name}(...)`,
        metadata: { name, file: rel },
      });
      serviceCount++;
    }
  }

  // Hooks written as const hook = () => { ... }
  for (const decl of sf.getVariableDeclarations()) {
    if (!hasExportModifier(decl)) continue;
    const name = decl.getName();
    const init = decl.getInitializer();
    if (!init) continue;
    if (init.getKind() !== SyntaxKind.ArrowFunction &&
        init.getKind() !== SyntaxKind.FunctionExpression) continue;
    if (/hooks\//.test(rel) && name.startsWith('use')) {
      emit({
        module: mod, category: 'hook', id: 'hook:' + normalizeHookId(name),
        location: locOf(decl), signature: `${name}(...)`,
        metadata: { name, file: rel },
      });
      hookCount++;
    }
  }

  // ── Contexts (React.createContext callsites + Provider components) ────────
  if (/contexts\//.test(rel)) {
    for (const decl of sf.getVariableDeclarations()) {
      if (!hasExportModifier(decl)) continue;
      const name = decl.getName();
      // Any export from a contexts file is an atom
      emit({
        module: '_config', category: 'context',
        id: 'context:' + name.toLowerCase(),
        location: locOf(decl), signature: `${name}`,
        metadata: { name, file: rel },
      });
      contextCount++;
    }
  }

  // ── DTOs (contracts package) ──────────────────────────────────────────────
  if (/packages\/contracts\/|\/types\//.test(rel)) {
    for (const iface of sf.getInterfaces()) {
      if (!hasExportModifier(iface)) continue;
      const name = iface.getName();
      emit({
        module: mod, category: 'dto', id: 'dto:' + normalizeDtoId(name),
        location: locOf(iface), signature: `interface ${name}`,
        metadata: { name, kind: 'interface' },
      });
      dtoCount++;
    }
    for (const alias of sf.getTypeAliases()) {
      if (!hasExportModifier(alias)) continue;
      const name = alias.getName();
      emit({
        module: mod, category: 'dto', id: 'dto:' + normalizeDtoId(name),
        location: locOf(alias), signature: `type ${name}`,
        metadata: { name, kind: 'type-alias' },
      });
      dtoCount++;
    }
  }

  // ── View atoms (extract from v2's *-parity.ts as ground truth) ────────────
  if (/components\/Views\/[a-z]+-parity\.ts$/.test(rel)) {
    // Every exported const in a parity file is an atom registry (union types,
    // const arrays of column keys, filter keys, modal names, etc).
    for (const decl of sf.getVariableDeclarations()) {
      if (!hasExportModifier(decl)) continue;
      const name = decl.getName();
      const init = decl.getInitializer();
      if (!init) continue;
      const viewName = rel.match(/([a-z]+)-parity\.ts$/)?.[1] ?? mod;

      // Array literal: each element is an atom
      if (init.getKind() === SyntaxKind.ArrayLiteralExpression) {
        const arr = init;
        for (const el of arr.getElements()) {
          const key = literalString(el) ?? el.getText();
          emit({
            module: mod, category: 'view-column',
            id: normalizeViewAtomId(viewName, name.toLowerCase(), key),
            location: locOf(el),
            signature: `${viewName}.${name}: ${key}`,
            metadata: { view: viewName, registry: name, key },
          });
          viewAtomCount++;
        }
      } else {
        // Non-array export — treat as a single atom
        emit({
          module: mod, category: 'view-action',
          id: normalizeViewAtomId(viewName, name.toLowerCase(), name),
          location: locOf(decl),
          signature: `${viewName}.${name}`,
          metadata: { view: viewName, registry: name },
        });
        viewAtomCount++;
      }
    }
  }

  // ── View atoms (regex-extract from View .tsx files) ───────────────────────
  const viewMatch = rel.match(/components\/Views\/([A-Z][a-zA-Z]+)View\.tsx$/) ??
                    rel.match(/pages\/([A-Z][a-zA-Z]+)\.tsx$/);
  if (viewMatch) {
    const viewName = viewMatch[1].toLowerCase();
    const src = sf.getFullText();
    // Table columns: const columns: ColumnDef = [ { key: 'x' }, ... ]
    //   or: const COLUMN_KEYS = ['a','b',...]
    const colsBlock = src.match(/(?:columns|COLUMNS|COLUMN_KEYS|columnDefs)\s*[:=]\s*\[([\s\S]*?)\]/);
    if (colsBlock) {
      const keys = [...colsBlock[1].matchAll(/key:\s*['"]([\w-]+)['"]|['"]([\w-]+)['"]/g)]
        .map((m) => m[1] ?? m[2])
        .filter(Boolean);
      for (const k of new Set(keys)) {
        emit({
          module: mod, category: 'view-column',
          id: normalizeViewAtomId(viewName, 'columns', k),
          location: { file: rel, line: 1 },
          signature: `${viewName} column ${k}`,
          metadata: { view: viewName, key: k },
        });
        viewAtomCount++;
      }
    }

    // Modals + drawers — JSX tags matching *Modal or *Drawer
    const modalMatches = [...src.matchAll(/<([A-Z][A-Za-z]+(?:Modal|Drawer))\b/g)];
    const seenModals = new Set();
    for (const m of modalMatches) {
      if (seenModals.has(m[1])) continue;
      seenModals.add(m[1]);
      emit({
        module: mod, category: 'view-modal',
        id: normalizeViewAtomId(viewName, 'modal', m[1]),
        location: { file: rel, line: 1 },
        signature: `${viewName} modal ${m[1]}`,
        metadata: { view: viewName, component: m[1] },
      });
      viewAtomCount++;
    }

    // Keyboard shortcuts — e.g. `if (e.key === 'p')` / event.key === "..."
    const keyMatches = [...src.matchAll(/(?:e|event)\.key\s*===?\s*['"]([^'"]+)['"]/g)];
    const seenKeys = new Set();
    for (const m of keyMatches) {
      if (seenKeys.has(m[1])) continue;
      seenKeys.add(m[1]);
      emit({
        module: mod, category: 'view-action',
        id: normalizeViewAtomId(viewName, 'keyboard', m[1]),
        location: { file: rel, line: 1 },
        signature: `${viewName} keyboard ${m[1]}`,
        metadata: { view: viewName, key: m[1] },
      });
      viewAtomCount++;
    }
  }

  // ── SQL schema extraction (v2 SQLite `CREATE TABLE` strings in repo files) ─
  // v2 schema lives embedded in data/sqlite-*-repository.ts files as literal
  // SQL strings. Parse out the table name + per-column declarations.
  if (side === 'v2' && /\/data\/sqlite-.*-repository\.ts$|\/test-support\.ts$/.test(rel)) {
    const src = sf.getFullText();
    // Match: CREATE TABLE [IF NOT EXISTS] name ( ... )
    const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)\s*;?/gi;
    let tm;
    while ((tm = tableRe.exec(src)) != null) {
      const tableName = tm[1];
      const colBlock = tm[2];
      // Emit table atom
      emit({
        module: mod, category: 'schema', id: normalizeSchemaId(tableName),
        location: { file: rel, line: 1 },
        signature: `table ${tableName}`,
        metadata: { table: tableName, source: 'sqlite-ddl' },
      });
      schemaCount++;
      // Parse columns (naive — split on commas at paren depth 0)
      const cols = splitSqlColumns(colBlock);
      for (const colDef of cols) {
        // Skip FOREIGN KEY / PRIMARY KEY / UNIQUE clauses that appear at table level
        if (/^\s*(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(colDef)) continue;
        const colMatch = colDef.trim().match(/^(\w+)\s+([A-Z][A-Z_0-9]*(?:\s*\(\d+(?:,\s*\d+)?\))?)/i);
        if (!colMatch) continue;
        const [, colName, colType] = colMatch;
        emit({
          module: mod, category: 'schema',
          id: normalizeSchemaId(tableName, colName),
          location: { file: rel, line: 1 },
          signature: `column ${tableName}.${colName} ${colType}`,
          metadata: {
            table: tableName, column: colName, type: colType,
            notNull: /\bNOT\s+NULL\b/i.test(colDef),
            primaryKey: /\bPRIMARY\s+KEY\b/i.test(colDef),
            hasDefault: /\bDEFAULT\b/i.test(colDef),
            source: 'sqlite-ddl',
          },
        });
        schemaCount++;
      }
    }
  }

  // Always discard the AST after processing (memory pressure on large repos)
  sf.forget();
}

// Split a SQL column-block by top-level commas (paren-aware).
function splitSqlColumns(block) {
  const out = [];
  let depth = 0, buf = '';
  for (const ch of block) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (buf.trim()) out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// ── CSS extractor ───────────────────────────────────────────────────────────
let cssCount = 0;
for (const abs of cssFiles) {
  const rel = relative(repoRoot, abs).split(sep).join('/');
  const mod = moduleFor(rel);
  if (!mod) continue;
  const src = readFileSync(abs, 'utf8');
  const classMatches = [...src.matchAll(/\.([a-zA-Z_][\w-]*)/g)];
  const seen = new Set();
  for (const m of classMatches) {
    const cls = m[1];
    if (seen.has(cls)) continue;
    seen.add(cls);
    emit({
      module: mod, category: 'css-class',
      id: 'css:' + normalizeCssClassId(cls),
      location: { file: rel, line: 1 },
      signature: `.${cls}`,
      metadata: { className: cls, file: rel },
    });
    cssCount++;
  }
}

// ── Summary to stderr (stdout is reserved for JSONL) ────────────────────────
const total = routeCount + serviceCount + schemaCount + dtoCount + constCount +
              hookCount + apiClientCount + viewAtomCount + ssCallCount +
              contextCount + cssCount;
console.error(`[${side}] extracted ${total} atoms:`,
  `route=${routeCount}`, `service=${serviceCount}`, `schema=${schemaCount}`,
  `dto=${dtoCount}`, `const=${constCount}`, `hook=${hookCount}`,
  `apiClient=${apiClientCount}`, `view=${viewAtomCount}`, `ss=${ssCallCount}`,
  `context=${contextCount}`, `css=${cssCount}`);

// ── Helpers ─────────────────────────────────────────────────────────────────
function literalString(node) {
  if (!node) return null;
  const k = node.getKind();
  if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.getLiteralValue();
  }
  return null;
}

function readStringProp(obj, propName) {
  const prop = obj.getProperty(propName);
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
  return literalString(prop.getInitializer());
}
