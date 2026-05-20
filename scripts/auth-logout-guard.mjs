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
  !authSource.includes('LOGOUT_REMOTE_TIMEOUT_MS'),
  'logout does not keep a background remote sign-out timer',
);
assert(
  signOutBlock.includes('setSession(null)') && signOutBlock.includes('setLoading(false)'),
  'logout clears React auth state immediately',
);
assert(
  signOutBlock.includes('setSession(null)') &&
    signOutBlock.includes('clearLocalSession()') &&
    signOutBlock.indexOf('setSession(null)') < signOutBlock.indexOf('clearLocalSession()'),
  'local auth state clears before local Supabase cleanup',
);
assert(
  authSource.includes("scope: 'local'") && signOutBlock.includes('clearLocalSession()'),
  'logout uses local-scope Supabase cleanup',
);
assert(
  !signOutBlock.includes('remoteSignOut') && !signOutBlock.includes('Promise.race'),
  'logout does not leave a late remote sign-out that can clear the next login',
);
assert(
  /signIn:\s*async\s*\(email,\s*password\)\s*=>\s*{[\s\S]*const\s+{\s*data,\s*error\s*}\s*=\s*await\s+supabase\.auth\.signInWithPassword/.test(authSource),
  'sign-in captures the returned Supabase session',
);
assert(
  /if\s*\(data\.session\)\s*setSession\(data\.session\)/.test(authSource),
  'sign-in applies the returned session immediately',
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
