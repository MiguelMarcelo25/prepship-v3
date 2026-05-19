import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const authPath = 'web/src/lib/auth.tsx';
const sidebarPath = 'web/src/components/Sidebar/variants/useSidebarController.ts';
const authSource = fs.readFileSync(path.join(root, authPath), 'utf8');
const sidebarSource = fs.readFileSync(path.join(root, sidebarPath), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const signOutStart = authSource.indexOf('signOut: async () => {');
const signOutEnd = signOutStart === -1 ? -1 : authSource.indexOf('resetPasswordForEmail:', signOutStart);
const signOutBlock =
  signOutStart === -1 || signOutEnd === -1
    ? ''
    : authSource.slice(signOutStart, signOutEnd);

assert(signOutBlock.length > 0, 'auth provider exposes signOut implementation');
assert(
  authSource.includes('LOGOUT_REMOTE_TIMEOUT_MS'),
  'logout uses a bounded remote sign-out timeout',
);
assert(
  signOutBlock.includes('setSession(null)') && signOutBlock.includes('setLoading(false)'),
  'logout clears React auth state immediately',
);
assert(
  signOutBlock.includes('setSession(null)') &&
    signOutBlock.includes('const remoteSignOut = supabase.auth') &&
    signOutBlock.indexOf('setSession(null)') <
      signOutBlock.indexOf('const remoteSignOut = supabase.auth'),
  'local auth state clears before waiting on remote Supabase sign-out',
);
assert(
  authSource.includes("scope: 'local'") && signOutBlock.includes('clearLocalSession()'),
  'logout falls back to local-scope Supabase cleanup',
);
assert(
  signOutBlock.includes('Promise.race'),
  'logout does not await remote Supabase sign-out indefinitely',
);
assert(
  sidebarSource.includes("navigate('/login', { replace: true })"),
  'sidebar still navigates to login after sign-out',
);
assert(
  packageJson.scripts?.['test:auth-logout'] === 'node scripts/auth-logout-guard.mjs',
  'package exposes auth logout guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
