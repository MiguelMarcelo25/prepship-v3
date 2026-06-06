// PS-107 — Master regression test runner.
//
// Runs a profile's worth of SAFE package scripts sequentially, CONTINUES past
// failures (so an early gate can't hide a later one), classifies each result by
// coverage type, and writes a report to test-results/master/.
//
// Usage:
//   node scripts/prepship-master-test.mjs <profile> [flags]
//   profile: quick | master | shipping | browser | all-safe   (default: quick)
//   flags:
//     --dry-run        list what would run; run nothing
//     --fail-fast      stop at first failure (default: continue)
//     --skip-browser   drop browser_e2e commands
//     --include-browser add browser_e2e commands even if profile excludes them
//     --group <name>   only commands in that domain group
//
// NEVER runs manual_live_gated commands. Exits nonzero if any executed command failed.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { manifestForProfile, PROFILES } from './prepship-master-test-manifest.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { profile: 'quick', dryRun: false, failFast: false, skipBrowser: false, includeBrowser: false, group: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--fail-fast') args.failFast = true;
    else if (a === '--skip-browser') args.skipBrowser = true;
    else if (a === '--include-browser') args.includeBrowser = true;
    else if (a === '--group') args.group = argv[++i];
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

function runOne(entry) {
  const start = Date.now();
  const res = spawnSync('npm', ['run', entry.command], {
    cwd: repoRoot,
    shell: true,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  const exitCode = res.status == null ? (res.error ? 1 : 0) : res.status;
  const tail = (s) => s.split('\n').filter(Boolean).slice(-8).join('\n');
  return {
    command: entry.command,
    group: entry.group,
    coverage: entry.coverage,
    safety: entry.safety,
    protects: entry.protects,
    durationMs,
    exitCode,
    passed: exitCode === 0,
    outputTail: tail(stdout + (stderr ? '\n' + stderr : '')),
    error: res.error ? String(res.error.message ?? res.error) : null,
  };
}

function writeArtifacts(report) {
  const dir = join(repoRoot, 'test-results', 'master');
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(report, null, 2);
  writeFileSync(join(dir, 'latest.json'), json);
  const stampFromCi = process.env.MASTER_RUN_STAMP || report.startedAt.replace(/[:.]/g, '-');
  writeFileSync(join(dir, `run-${stampFromCi}.json`), json);

  const md = [];
  md.push(`# Master regression run — ${report.profile}`);
  md.push('');
  md.push(`- started: ${report.startedAt}`);
  md.push(`- commands: ${report.summary.total}  ·  passed: ${report.summary.passed}  ·  failed: ${report.summary.failed}  ·  duration: ${(report.summary.durationMs / 1000).toFixed(1)}s`);
  md.push('');
  md.push('| Result | Command | Group | Coverage | ms |');
  md.push('|---|---|---|---|---|');
  for (const r of report.results) {
    md.push(`| ${r.passed ? '✅' : '❌'} | \`${r.command}\` | ${r.group} | ${r.coverage} | ${r.durationMs} |`);
  }
  if (report.summary.failed > 0) {
    md.push('');
    md.push('## Failures');
    for (const r of report.results.filter((x) => !x.passed)) {
      md.push(`\n### ❌ \`${r.command}\` (exit ${r.exitCode})`);
      md.push('```');
      md.push(r.outputTail || r.error || '(no output)');
      md.push('```');
    }
  }
  writeFileSync(join(dir, 'latest.md'), md.join('\n') + '\n');
  writeFileSync(join(dir, `run-${stampFromCi}.md`), md.join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const commands = selectCommands(args);
  // Stable timestamp via env (scripts can't call Date.now under sandbox; here we
  // run as a normal node process so Date is available).
  const startedAt = new Date().toISOString();

  console.log(`\nPS-107 master runner — profile=${args.profile}${args.group ? ` group=${args.group}` : ''}${args.dryRun ? ' (dry-run)' : ''}`);
  console.log(`Selected ${commands.length} safe command(s). Manual/live-gated commands are excluded by design.\n`);

  if (args.dryRun) {
    for (const e of commands) console.log(`  • ${e.command.padEnd(48)} [${e.coverage}/${e.group}]`);
    console.log(`\nDry-run: nothing executed.`);
    return;
  }

  const results = [];
  for (const entry of commands) {
    process.stdout.write(`▶ ${entry.command} … `);
    const r = runOne(entry);
    results.push(r);
    console.log(`${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`);
    if (!r.passed && args.failFast) break;
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const report = {
    profile: args.profile,
    startedAt,
    summary: { total: results.length, passed, failed, durationMs: results.reduce((s, r) => s + r.durationMs, 0) },
    results,
  };
  writeArtifacts(report);

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`Total ${results.length}  ·  ✅ ${passed}  ·  ❌ ${failed}`);
  console.log(`Report: test-results/master/latest.md`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => !x.passed)) console.log(`  ❌ ${r.command} (exit ${r.exitCode})`);
    process.exit(1);
  }
}

main();
