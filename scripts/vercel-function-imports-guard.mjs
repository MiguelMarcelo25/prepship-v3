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

const directCarrierLabels = fs.readFileSync(path.join(root, 'api/carriers/labels.ts'), 'utf8');
if (directCarrierLabels.includes('src/connectors/carrier-resolution')) {
  fail('api/carriers/labels.ts must not import connector-resolution; Vercel cannot load its extensionless transitive imports');
} else {
  pass('direct carrier labels avoid connector-resolution runtime import');
}

// labels.ts must lazy-load the connector/label trees for the SAME reason
// rates.ts does: a STATIC top-level import of the carrier/store orchestrators +
// shipping-eligibility tree pulls a wide src/ bundle that throws at Vercel COLD
// START, crashing the whole function (FUNCTION_INVOCATION_FAILED) before the
// handler runs. That made every direct-carrier label (shipp/ups/easypost/
// walmart) fail uniformly while ShipStation (a separate Render path) worked.
// These must be loaded via dynamic import() inside the handler, not `from`.
const FORBIDDEN_LABEL_STATIC_IMPORTS = [
  "from '../../src/services/carrier-connector-orchestrator.js'",
  "from '../../src/services/store-connector-orchestrator.js'",
  "from '../../src/connectors/store/walmart.js'",
  "from '../../src/services/direct-label-persistence.js'",
  "from '../../src/services/fulfillment/schema-readiness.js'",
  "from '../../src/lib/shipping-options.js'",
  "from '../../src/lib/shipping-service-eligibility.js'",
];
const labelStaticOffenders = FORBIDDEN_LABEL_STATIC_IMPORTS.filter((spec) => directCarrierLabels.includes(spec));
if (labelStaticOffenders.length) {
  fail(
    'api/carriers/labels.ts must lazy-load connector/label trees (Vercel cold-start crash); ' +
    `move these to dynamic import() inside the handler:\n${labelStaticOffenders.join('\n')}`,
  );
} else {
  pass('direct carrier labels lazy-load connector/label trees after request validation');
}

const directCarrierRates = fs.readFileSync(path.join(root, 'api/carriers/rates.ts'), 'utf8');
if (
  directCarrierRates.includes("from '../../src/connectors/carrier/direct-rates.js'") ||
  directCarrierRates.includes("from '../../src/connectors/store/walmart.js'") ||
  directCarrierRates.includes("from '../../src/services/carrier-connector-orchestrator.js'") ||
  directCarrierRates.includes("from '../../src/connectors/carrier-resolution.js'")
) {
  fail('api/carriers/rates.ts must lazy-load rate connectors; Vercel must boot OPTIONS/auth without importing connector trees');
} else {
  pass('direct carrier rates lazy-load connector trees after request validation');
}

const lazilyLoadedRuntimeFiles = [
  'src/lib/shipping-service-eligibility.ts',
  'src/connectors/store/walmart.ts',
  'src/connectors/carrier/amazon-shipping.ts',
  'src/connectors/carrier/easypost.ts',
  'src/connectors/carrier/ebay-shipping.ts',
  'src/connectors/carrier/fedex.ts',
  'src/connectors/carrier/shipengine.ts',
  'src/connectors/carrier/shipp.ts',
  'src/connectors/carrier/ups.ts',
  'src/connectors/carrier/usps.ts',
  'src/connectors/carrier/walmart-shipping.ts',
  'src/lib/shipstation/client.ts',
  'src/lib/shipstation/index.ts',
  'src/lib/shipstation/labels.ts',
  'src/lib/shipstation/v1-client.ts',
];

const extensionlessRuntimeImports = [];
for (const relPath of lazilyLoadedRuntimeFiles) {
  const source = fs.readFileSync(path.join(root, relPath), 'utf8');
  const importPattern = /^import\s+(?!type\b)[\s\S]*?\sfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gm;
  const exportPattern = /^export\s+\*\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/gm;
  for (const pattern of [importPattern, exportPattern]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.endsWith('.js') && !specifier.endsWith('.json')) {
        extensionlessRuntimeImports.push(`${relPath}: ${specifier}`);
      }
    }
  }
}

if (extensionlessRuntimeImports.length) {
  fail(`Vercel lazy-loaded connector files need .js runtime specifiers:\n${extensionlessRuntimeImports.join('\n')}`);
} else {
  pass('Vercel lazy-loaded connector files use runtime-safe .js specifiers');
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
