// PS-484 — each rule this card added must be KILLED by a guard when broken. Static guards only
// (no database): mutate the source, run the guard that owns the rule, restore, report.
//
//   node scripts/ps-484-stale-reasons-mutations.mjs            # all mutations
//   PS484_MUTATIONS_ONLY=<regex> node scripts/ps-484-stale-reasons-mutations.mjs
//
// Every mutation is applied to a working tree that is otherwise clean of these files; the file is
// restored byte-for-byte after each run, and on any signal or throw. A mutation that no guard
// kills is a hole in the gate, and the harness exits non-zero.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const OWNER = 'src/services/order-sync-account-stale.ts';
const SYNC = 'src/services/order-sync.ts';
const WATCHDOG = 'src/services/shipment-sync-watchdog.ts';
const PS409 = 'npm run -s test:ps-409-status-catchup-backlog';
const PS417 = 'npm run -s test:ps-417-shipstation-sync-account-state';
const AUDIT = 'npm run -s test:audit-sync-watchdog-lifecycle';

/** Replace exactly one occurrence of `from` (string or RegExp) with `to`; refuse 0 or >1. */
function replaceOnce(source, from, to, label) {
  const matches = from instanceof RegExp ? (source.match(from) ?? []).length : source.split(from).length - 1;
  if (matches !== 1) throw new Error(`${label}: anchor matched ${matches} times (expected 1)`);
  return source.replace(from, () => to);
}

// [name, file, checks, from, to] — the mutation is "replace `from` with `to`", once.
const RESTATED_BOOLEAN =
  'return input.failed || input.watermarkMs === null'
  + ' || (input.ageMs !== null && input.ageMs > input.freshMs)'
  + ' || stalled(input.statusBacklogEntries) || stalled(input.awaitingBacklogEntries);';
const RETRY_NEW = [
  '      abandoned: false,',
  '      recovering: true,',
  "      error: 'Order sync attempt failed and is queued to retry.',",
].join('\n');
const RETRY_OLD = [
  '      abandoned: true,',
  '      recovering: false,',
  "      error: 'Order sync timed out and is waiting to retry.',",
].join('\n');
const ORPHAN_NEW = '  return {\n    running: false,\n    abandoned: true,\n    recovering: false,\n    error: !withinLease';
const ORPHAN_OFF = '  return {\n    running: false,\n    abandoned: false,\n    recovering: false,\n    error: !withinLease';
const REASON_NEW = '      reason: `${staleOrderAccountCount} order sync account(s) are stale or failed${detail}`,';
const REASON_OLD = '      reason: `${staleOrderAccountCount} order sync account(s) are stale or failed`,';
const DESCRIBE_NEW = "      const reasons = account.staleReasons.length > 0 ? account.staleReasons.join('+') : 'unknown';";
const DESCRIBE_OFF = "      const reasons = 'stale';";

const MUTATIONS = [
  ['reasons: an abandoned run is no longer a clause', OWNER, [PS409],
    "  if (input.runAbandoned) reasons.push('run_abandoned');\n", ''],
  ['reasons: a never-synced account is no longer a clause', OWNER, [PS409],
    "  if (input.watermarkMs === null) reasons.push('never_synced');\n", ''],
  ['reasons: a draining backlog counts as stalled again (the ae59ab07 bug)', OWNER, [PS409],
    'entries.some((entry) => entry.stalledPasses >= STALLED_PASS_ALERT_THRESHOLD)', 'entries.length > 0'],
  ['boolean: restates the clauses instead of delegating (placement pin)', OWNER, [PS409],
    /return orderSyncAccountStaleReasons\(\{[\s\S]*?\}\)\.length > 0;/, RESTATED_BOOLEAN],
  ['diagnostics: the loop computes stale on its own again (placement pin)', SYNC, [PS409],
    '    const stale = staleReasons.length > 0;',
    '    const stale = failed || watermarkMs === null || (ageMs !== null && ageMs > freshMs);'],
  ['verdict: a queued retry is abandoned again', SYNC, [PS417], RETRY_NEW, RETRY_OLD],
  ['verdict: a run no queue row owns is never abandoned', SYNC, [PS417], ORPHAN_NEW, ORPHAN_OFF],
  ['watchdog: the 503 reason drops the account detail', WATCHDOG, [AUDIT], REASON_NEW, REASON_OLD],
  ['watchdog: the description hides the clause', WATCHDOG, [AUDIT], DESCRIBE_NEW, DESCRIBE_OFF],
].map(([name, file, checks, from, to]) => ({
  name,
  file,
  checks,
  apply: (source) => replaceOnce(source, from, to, name),
}));

const only = process.env.PS484_MUTATIONS_ONLY ? new RegExp(process.env.PS484_MUTATIONS_ONLY, 'i') : null;
const selected = only ? MUTATIONS.filter((m) => only.test(m.name)) : MUTATIONS;
if (selected.length === 0) {
  console.error('no mutation matches PS484_MUTATIONS_ONLY');
  process.exit(1);
}

const originals = new Map();
for (const file of new Set(selected.map((m) => m.file))) originals.set(file, readFileSync(file, 'utf8'));
let pending = null;

function restore() {
  if (!pending) return;
  // Windows can fail a restore write (errno -4094) and leave the tree MUTATED; retry, and keep
  // `pending` set until the bytes on disk equal the original.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      writeFileSync(pending, originals.get(pending));
      if (readFileSync(pending, 'utf8') === originals.get(pending)) {
        pending = null;
        return;
      }
    } catch (error) {
      if (attempt === 3) console.error(`restore attempt ${attempt} failed: ${error.message}`);
    }
  }
  console.error(`RESTORE FAILED for ${pending} — run: git checkout -- ${pending}`);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}
process.on('exit', restore);

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 5 * 60_000, env: { ...process.env, FORCE_COLOR: '0' } });
    return true;
  } catch {
    return false;
  }
}

// Anchors must exist before any baseline runs, so a rename shows up as "infra", never "survived".
for (const m of selected) m.apply(originals.get(m.file));
for (const check of new Set(selected.flatMap((m) => m.checks))) {
  if (!run(check)) {
    console.error(`baseline red: ${check} — refusing to attribute anything`);
    process.exit(2);
  }
  console.log(`baseline: "${check}" green on the unmutated tree`);
}

let survived = 0;
for (const m of selected) {
  pending = m.file;
  writeFileSync(m.file, m.apply(originals.get(m.file)));
  const killer = m.checks.find((check) => !run(check));
  restore();
  if (readFileSync(m.file, 'utf8') !== originals.get(m.file)) {
    console.error(`RESTORE FAILED for ${m.file}`);
    process.exit(3);
  }
  if (killer) console.log(`  killed       ${m.name}  [${killer.replace('npm run -s ', '')}]`);
  else {
    survived += 1;
    console.error(`  SURVIVED     ${m.name}`);
  }
}
console.log(`\n${selected.length - survived}/${selected.length} mutations killed`);
process.exit(survived === 0 ? 0 : 1);
