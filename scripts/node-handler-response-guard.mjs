import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/lib/node-handler.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert(
  source.includes('function setBody(payload?: unknown)'),
  'node-handler must centralize response body normalization',
);

assert(
  source.includes("responseHeaders.set('Content-Type', 'application/json')") &&
    source.includes('body = JSON.stringify(payload)'),
  'node-handler must serialize object payloads passed to res.end/json as JSON',
);

assert(
  source.includes('payload instanceof ArrayBuffer') &&
    source.includes('new Uint8Array(payload)'),
  'node-handler must support ArrayBuffer response bodies',
);

assert(
  source.includes('end(payload?: unknown)') &&
    !source.includes('end(payload?: string | Uint8Array | Buffer | null)'),
  'node-handler res.end must accept unknown imported-handler payloads without throwing Response body type errors',
);

assert(
  pkg.scripts?.['test:node-handler-response'] === 'node scripts/node-handler-response-guard.mjs',
  'package.json must expose test:node-handler-response',
);

console.log('PASS node handler response guard');
