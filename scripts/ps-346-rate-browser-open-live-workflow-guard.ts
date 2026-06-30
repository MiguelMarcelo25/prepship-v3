import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rateBrowserOpenBrowseOptions } from '../web/src/components/rate-browser-open-workflow';

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');

assert.deepEqual(
  rateBrowserOpenBrowseOptions(),
  { forceLive: true },
  'Rate Browser open should request the backend live workflow across all scoped carriers',
);

const openEffect = modal.slice(
  modal.indexOf('// Start the live carrier workflow on open'),
  modal.indexOf('// Auto-select a package'),
);

assert.ok(
  openEffect.includes('void browseRates(undefined, rateBrowserOpenBrowseOptions())'),
  'Rate Browser open effect must delegate to the open-workflow helper',
);
assert.ok(
  !openEffect.includes('cachedOnly: true'),
  'Rate Browser open must not stop at cached-only partial coverage',
);
assert.ok(
  modal.includes("import { rateBrowserOpenBrowseOptions } from './rate-browser-open-workflow';"),
  'RateBrowserModal must import the focused open-workflow helper',
);
assert.ok(
  modal.includes('onClick={() => void browseRates(undefined, { forceLive: true })}'),
  'manual Refresh Live Rates button must remain an explicit live workflow retry',
);
assert.ok(
  packageJson.includes('"test:ps-346-rate-browser-open-live-workflow"'),
  'package.json must wire the PS-346 Rate Browser open live workflow guard',
);

console.log('PASS PS-346 Rate Browser open live workflow guard');
