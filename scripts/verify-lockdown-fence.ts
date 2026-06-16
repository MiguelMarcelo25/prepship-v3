/**
 * PS-245 (Card 0): lockdown file-fence (CI driver). Fails a diff that touches a shipped/cancelled
 * LOCKED surface unless the commit range carries the `unlock shipped data` override — enforcing the
 * AGENTS.md/CLAUDE.md bypass procedure automatically instead of relying on the honor system.
 *
 * NOT named test:* on purpose, so the master-test manifest does NOT auto-run it (its result depends
 * on a git diff base, which would be unstable in the offline all-safe profile). Wire it into CI:
 *   node scripts/verify-lockdown-fence.ts [baseRef]      # default origin/main
 */
import { execSync } from 'node:child_process';
import { lockdownPathsTouched, hasLockdownOverride, LOCKDOWN_OVERRIDE_PHRASE } from './fence-match';

const base = process.argv[2] ?? 'origin/main';

let files: string[] = [];
let messages = '';
try {
  files = execSync(`git diff --name-only ${base}...HEAD`, { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  messages = execSync(`git log ${base}...HEAD --format=%B`, { encoding: 'utf8' });
} catch (err) {
  // Base ref unavailable (shallow clone / detached) — don't block; the all-safe baseline-diff still guards.
  console.error(`[lockdown-fence] could not compute diff vs ${base}: ${err instanceof Error ? err.message : err}`);
  process.exit(0);
}

const touched = lockdownPathsTouched(files);
if (touched.length === 0) {
  console.log('[lockdown-fence] OK — no shipped/cancelled locked surfaces touched.');
  process.exit(0);
}
if (hasLockdownOverride(messages)) {
  console.log(`[lockdown-fence] OK — locked surfaces changed WITH the override:\n  ${touched.join('\n  ')}`);
  process.exit(0);
}
console.error(
  `[lockdown-fence] FAIL — these shipped/cancelled LOCKED surfaces changed without the ` +
    `"${LOCKDOWN_OVERRIDE_PHRASE}" override in any commit message:\n  ${touched.join('\n  ')}\n` +
    `If this is intentional, follow the AGENTS.md bypass procedure and cite the override in the commit.`,
);
process.exit(1);
