import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const apiRoot = path.join(root, 'api');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

const offenders = [];
for (const filePath of walk(apiRoot)) {
  const relPath = path.relative(root, filePath).replaceAll(path.sep, '/');
  const source = fs.readFileSync(filePath, 'utf8');
  const importPattern = /from\s+['"]([^'"]*\.\.\/(?:\.\.\/)*(?:src)\/[^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.endsWith('.js')) {
      offenders.push(`${relPath}: ${specifier}`);
    }
  }
}

if (offenders.length) {
  fail(`Vercel function shared src imports need .js runtime specifiers:\n${offenders.join('\n')}`);
} else {
  pass('Vercel function shared src imports use runtime-safe .js specifiers');
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
