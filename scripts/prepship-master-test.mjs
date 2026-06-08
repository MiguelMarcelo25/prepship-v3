// PS-110 — Master regression test runner v2.
//
// Runs a profile's LEAF commands with a lock-aware parallel scheduler, CONTINUES
// past failures (so an early gate can't hide a later one), classifies each result,
// writes an isolated shard file per command, and always aggregates a final report
// (even when commands fail or the run is interrupted).
//
// Usage:
//   node scripts/prepship-master-test.mjs <profile> [flags]
//   profile: quick | master | shipping | browser | all-safe | live-readonly  (default: quick)
//   flags:
//     --concurrency <n>  max parallel commands (default: min(8, cpus-2))
//     --dry-run          list what would run; run nothing
//     --fail-fast        stop launching new commands after the first failure
//     --skip-browser     drop browser_e2e commands
//     --include-browser  add browser_e2e commands even if the profile excludes them
//     --group <name>     only commands in that domain group
//
// Scheduling: commands sharing a resourceLock (e.g. 'browser', 'build', 'db') are
// serialised against each other; everything else runs in parallel up to the cap.
// NEVER runs manual_live_gated commands. Exits nonzero if any executed command failed.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { manifestForProfile, PROFILES } from './prepship-master-test-manifest.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK_TARGET_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(8, (os.cpus()?.length ?? 4) - 2));

function parseArgs(argv) {
  const args = {
    profile: 'quick', dryRun: false, failFast: false, skipBrowser: false,
    includeBrowser: false, group: null, concurrency: DEFAULT_CONCURRENCY,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--fail-fast') args.failFast = true;
    else if (a === '--skip-browser') args.skipBrowser = true;
    else if (a === '--include-browser') args.includeBrowser = true;
    else if (a === '--group') args.group = argv[++i];
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number.parseInt(argv[++i], 10) || DEFAULT_CONCURRENCY);
    else if (!a.startsWith('--') && PROFILES.includes(a)) args.profile = a;
  }
  return args;
}

function selectCommands(args) {
  let list = manifestForProfile(args.profile);
  if (args.includeBrowser) {
    const browser = manifestForProfile('browser');
    const seen = new Set(list.map((e) => e.command));
    for (const e of browser) if (!seen.has(e.command)) list.push(e);
  }
  if (args.skipBrowser) list = list.filter((e) => e.coverage !== 'browser_e2e');
  if (args.group) list = list.filter((e) => e.group === args.group);
  // Hard safety net: a manual_live_gated command can never reach the runner.
  list = list.filter((e) => e.coverage !== 'manual_live_gated');
  return list;
}

function safeName(command) {
  return command.replace(/[^a-z0-9._-]+/gi, '_');
}

function tail(s, n = 8) {
  return String(s).split('\n').filter(Boolean).slice(-n).join('\n');
}

function runOneAsync(entry) {
  const start = Date.now();
  const npmArgs = ['run', entry.command, ...(entry.args?.length ? ['--', ...entry.args] : [])];
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('npm', npmArgs, { cwd: repoRoot, shell: true });
    const timer = setTimeout(() => {
      if (!settled) { try { child.kill('SIGKILL'); } catch {} }
    }, 10 * 60 * 1000);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    const finish = (exitCode, errMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: entry.command,
        args: entry.args ?? [],
        group: entry.group,
        coverage: entry.coverage,
        safety: entry.safety,
        protects: entry.protects ?? [],
        resourceLocks: entry.resourceLocks ?? [],
        estimatedMs: entry.estimatedMs ?? null,
        requiresLiveData: !!entry.requiresLiveData,
        requiresProviderAccess: !!entry.requiresProviderAccess,
        requiresOrderId: !!entry.requiresOrderId,
        durationMs: Date.now() - start,
        exitCode,
        passed: exitCode === 0,
        outputTail: tail(stdout + (stderr ? '\n' + stderr : '')),
        error: errMsg ?? null,
      });
    };
    child.on('error', (err) => finish(1, String(err?.message ?? err)));
    child.on('close', (code) => finish(code == null ? 1 : code, null));
  });
}

// Lock-aware parallel pool: commands sharing a resourceLock never run together;
// everything else runs up to `concurrency`. Slowest/locked work is launched first.
async function runScheduler(commands, { concurrency, failFast, onResult }) {
  const pending = [...commands].sort((a, b) => (b.estimatedMs ?? 0) - (a.estimatedMs ?? 0));
  const held = new Set();
  const results = [];
  let active = 0;
  let aborted = false;

  return await new Promise((resolve) => {
    const pump = () => {
      if (aborted && active === 0) return resolve(results);
      for (let i = 0; i < pending.length && active < concurrency; ) {
        const entry = pending[i];
        const blocked = (entry.resourceLocks ?? []).some((l) => held.has(l));
        if (aborted || blocked) { i += 1; continue; }
        pending.splice(i, 1);
        for (const l of entry.resourceLocks ?? []) held.add(l);
        active += 1;
        runOneAsync(entry).then((r) => {
          results.push(r);
          try { onResult(r); } catch {}
          for (const l of entry.resourceLocks ?? []) held.delete(l);
          active -= 1;
          if (!r.passed && failFast) { aborted = true; pending.length = 0; }
          pump();
        });
      }
      if (active === 0 && pending.length === 0) resolve(results);
    };
    pump();
  });
}

function buildReport(profile, args, startedAt, results, { interrupted = false } = {}) {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const wallMs = results.length ? Math.max(...results.map((r) => r.durationMs)) : 0;
  const byProfile = {};
  for (const r of results) {
    (byProfile[r.group] ??= { total: 0, passed: 0, failed: 0 });
    byProfile[r.group].total += 1;
    byProfile[r.group][r.passed ? 'passed' : 'failed'] += 1;
  }
  return {
    profile,
    concurrency: args.concurrency,
    startedAt,
    interrupted,
    summary: {
      total: results.length,
      passed,
      failed,
      durationMs: results.reduce((s, r) => s + r.durationMs, 0),
      wallMs,
      slowest: [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
        .map((r) => ({ command: r.command, durationMs: r.durationMs })),
      byGroup: byProfile,
    },
    results,
  };
}

function writeArtifacts(report, runDir) {
  const dir = join(repoRoot, 'test-results', 'master');
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(report, null, 2);
  const stamp = process.env.MASTER_RUN_STAMP || report.startedAt.replace(/[:.]/g, '-');
  writeFileSync(join(dir, 'latest.json'), json);
  writeFileSync(join(dir, `run-${stamp}.json`), json);

  const md = [];
  md.push(`# Master regression run — ${report.profile}${report.interrupted ? ' (INTERRUPTED)' : ''}`);
  md.push('');
  md.push(`- started: ${report.startedAt}  ·  concurrency: ${report.concurrency}`);
  md.push(`- commands: ${report.summary.total}  ·  ✅ ${report.summary.passed}  ·  ❌ ${report.summary.failed}`);
  md.push(`- wall time: ${(report.summary.wallMs / 1000).toFixed(1)}s  ·  cpu time: ${(report.summary.durationMs / 1000).toFixed(1)}s`);
  md.push('');
  md.push('## Profile summary (by group)');
  md.push('| Group | Total | ✅ | ❌ |');
  md.push('|---|---|---|---|');
  for (const [g, s] of Object.entries(report.summary.byGroup).sort()) {
    md.push(`| ${g} | ${s.total} | ${s.passed} | ${s.failed} |`);
  }
  md.push('');
  md.push('## Slowest commands');
  for (const s of report.summary.slowest) md.push(`- \`${s.command}\` — ${(s.durationMs / 1000).toFixed(1)}s`);
  md.push('');
  md.push('| Result | Command | Group | Coverage | Safety | Locks | ms |');
  md.push('|---|---|---|---|---|---|---|');
  for (const r of [...report.results].sort((a, b) => a.command.localeCompare(b.command))) {
    md.push(`| ${r.passed ? '✅' : '❌'} | \`${r.command}\` | ${r.group} | ${r.coverage} | ${r.safety} | ${(r.resourceLocks || []).join(',') || '-'} | ${r.durationMs} |`);
  }
  if (report.summary.failed > 0) {
    md.push('');
    md.push('## Failures');
    for (const r of report.results.filter((x) => !x.passed)) {
      md.push(`\n### ❌ \`${r.command}\` (exit ${r.exitCode}) — ${r.coverage}/${r.group}`);
      md.push('```');
      md.push(r.outputTail || r.error || '(no output)');
      md.push('```');
    }
  }
  writeFileSync(join(dir, 'latest.md'), md.join('\n') + '\n');
  writeFileSync(join(dir, `run-${stamp}.md`), md.join('\n') + '\n');
  return { dir, stamp };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const commands = selectCommands(args);
  const startedAt = new Date().toISOString();
  const stamp = process.env.MASTER_RUN_STAMP || startedAt.replace(/[:.]/g, '-');
  const runDir = join(repoRoot, 'test-results', 'master', `run-${stamp}`);
  const shardDir = join(runDir, 'shards');

  console.log(`\nPS-110 master runner v2 — profile=${args.profile}${args.group ? ` group=${args.group}` : ''} concurrency=${args.concurrency}${args.dryRun ? ' (dry-run)' : ''}`);
  console.log(`Selected ${commands.length} safe command(s). Manual/live-gated commands are excluded by design.\n`);

  if (args.dryRun) {
    for (const e of commands) {
      const flags = [
        e.resourceLocks?.length ? `lock:${e.resourceLocks.join('+')}` : null,
        e.args?.length ? `args:${e.args.join(' ')}` : null,
        e.requiresLiveData ? 'live' : null,
      ].filter(Boolean).join(' ');
      console.log(`  • ${e.command.padEnd(48)} [${e.coverage}/${e.group}]${flags ? '  ' + flags : ''}`);
    }
    console.log(`\nDry-run: nothing executed.`);
    return;
  }

  mkdirSync(shardDir, { recursive: true });
  const collected = [];
  let finalized = false;
  const finalize = (interrupted) => {
    if (finalized) return;
    finalized = true;
    const report = buildReport(args.profile, args, startedAt, collected, { interrupted });
    const { dir } = writeArtifacts(report, runDir);
    console.log(`\n${'─'.repeat(56)}`);
    console.log(`Total ${report.summary.total}  ·  ✅ ${report.summary.passed}  ·  ❌ ${report.summary.failed}  ·  wall ${(report.summary.wallMs / 1000).toFixed(1)}s`);
    if (args.profile === 'quick' && report.summary.wallMs > QUICK_TARGET_MS) {
      console.log(`⚠ quick profile exceeded its 5-minute target (${(report.summary.wallMs / 1000).toFixed(1)}s).`);
    }
    console.log(`Report: test-results/master/latest.md  ·  shards: test-results/master/run-${stamp}/shards/`);
    return report;
  };

  // Write a shard the moment a command finishes, so a crash/interrupt never loses
  // completed results.
  const onResult = (r) => {
    collected.push(r);
    try { writeFileSync(join(shardDir, `${safeName(r.command)}.json`), JSON.stringify(r, null, 2)); } catch {}
    process.stdout.write(`${r.passed ? '✅' : '❌'} ${r.command} (${(r.durationMs / 1000).toFixed(1)}s)\n`);
  };

  let interrupted = false;
  const onSigint = () => { interrupted = true; const rep = finalize(true); process.exit(rep && rep.summary.failed === 0 ? 130 : 130); };
  process.on('SIGINT', onSigint);

  await runScheduler(commands, { concurrency: args.concurrency, failFast: args.failFast, onResult });

  const report = finalize(interrupted);
  if (report.summary.failed > 0) {
    console.log('\nFailures:');
    for (const r of report.results.filter((x) => !x.passed)) console.log(`  ❌ ${r.command} (exit ${r.exitCode})`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('master runner crashed:', err);
  process.exit(1);
});
