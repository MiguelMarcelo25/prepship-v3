import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const marketplaceOrderPullers = [
  'api/carriers/walmart/orders.ts',
  'api/carriers/ebay/orders.ts',
];

for (const rel of marketplaceOrderPullers) {
  const source = read(rel);

  assert(
    source.includes("from '../../../src/lib/auth/verify-supabase-jwt.js'"),
    `${rel} uses the shared Supabase JWT verifier`
  );
  assert(
    source.includes("from '../../../src/lib/http/cors.js'"),
    `${rel} uses the shared CORS helper`
  );
  assert(
    source.includes('extractBearerToken('),
    `${rel} uses the shared Bearer-token parser`
  );
  assert(
    !source.includes("from 'jose'"),
    `${rel} does not carry a local jose verifier copy`
  );
  assert(
    !/function\s+corsHeaders\s*\(/.test(source),
    `${rel} does not carry a local CORS allowlist copy`
  );
  assert(
    !/function\s+getJwks\s*\(/.test(source),
    `${rel} does not carry a local JWKS cache copy`
  );
}

const sourceAudit = read('SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md');
assert(
  sourceAudit.includes('Marketplace order pullers now use the shared JWT verifier and CORS helper'),
  'source-of-truth audit records marketplace JWT/CORS consolidation'
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
