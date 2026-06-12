import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const sourcePaths = [
  'web/src/lib/api.ts',
  'web/src/lib/v2-apiClient.ts',
  'web/src/lib/vercelFunction.ts',
];

// PS-200 S1 re-anchor: useShippingAccounts no longer holds ANY auth code —
// its raw fetch (which needed getCachedAuthToken) was replaced by the shared
// api client, whose getCachedAuthToken usage is pinned above. The file keeps
// the negative pin (must not call supabase.auth.getSession directly); the
// positive "uses getCachedAuthToken" pin is dropped for it because requiring
// it would force auth code back INTO the hook. Same intent, stricter outcome.
const noDirectSessionPaths = [
  'web/src/hooks/useShippingAccounts.ts',
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const cachePath = 'web/src/lib/auth-session-cache.ts';
const cacheExists = fs.existsSync(path.join(root, cachePath));
const cacheSource = cacheExists ? read(cachePath) : '';

assert(cacheExists, 'frontend auth session cache helper exists');
assert(
  cacheSource.includes('getCachedAuthToken') && cacheSource.includes('supabase.auth.getSession()'),
  'cache helper owns the only frontend shared-client getSession call',
);
assert(
  cacheSource.includes('onAuthStateChange') && cacheSource.includes('cachedAccessToken'),
  'cache helper invalidates cached token from auth state changes',
);

for (const sourcePath of sourcePaths) {
  const source = read(sourcePath);
  assert(
    !source.includes('supabase.auth.getSession()'),
    `${sourcePath} does not call supabase.auth.getSession directly`,
  );
  assert(
    source.includes('getCachedAuthToken'),
    `${sourcePath} uses getCachedAuthToken`,
  );
}

for (const sourcePath of noDirectSessionPaths) {
  const source = read(sourcePath);
  assert(
    !source.includes('supabase.auth.getSession()'),
    `${sourcePath} does not call supabase.auth.getSession directly`,
  );
}

const apiSource = read('web/src/lib/api.ts');
assert(
  apiSource.includes('authDurationMs') &&
    apiSource.includes('fetchDurationMs') &&
    apiSource.includes('totalDurationMs'),
  'api client timing logs include auth, fetch, and total duration fields',
);

assert(
  packageJson.scripts?.['test:frontend-auth-cache'] ===
    'node scripts/frontend-auth-cache-guard.mjs',
  'package exposes frontend auth cache guard',
);

assert(
  packageJson.dependencies?.['@supabase/supabase-js'] === '^2.106.1',
  'package uses upgraded Supabase JS dependency',
);
assert(
  lockJson.packages?.['node_modules/@supabase/supabase-js']?.version === '2.106.1',
  'package lock pins upgraded Supabase JS dependency',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
