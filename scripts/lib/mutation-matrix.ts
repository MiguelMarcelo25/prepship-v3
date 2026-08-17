/**
 * A mutation-matrix runner, shared by the per-ticket matrices.
 *
 * A guard passing against correct code proves nothing. It proves something only if it goes
 * RED when the defect is put back, and red for the RIGHT reason. This reintroduces each
 * defect one at a time and requires the guard to fail at the specific check that owns it —
 * "some check failed" is rejected, because a mutation that trips an unrelated assertion would
 * let a bare spot hide behind a neighbour.
 *
 * How the reason is verified: guards print `ok   <label>` (or `  ok  <label>`) per passing
 * check. A clean run supplies the canonical ordered label list; under a mutation the FIRST
 * absent label must be exactly the expected one.
 *
 * Extracted from the PS-500 matrix when PS-502 needed the same machinery. Copying it would
 * have let the two drift, and a matrix that quietly stops verifying reasons is worse than no
 * matrix — it still reports passes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * tsx's entry, run under this same node binary. Not `npx`: that resolves to a `.cmd` shim on
 * Windows, which node refuses to spawn without a shell, and enabling the shell concatenates
 * arguments instead of escaping them.
 */
const TSX_CLI = 'node_modules/tsx/dist/cli.mjs';

export type Mutation = {
  id: string;
  /** The defect being put back, in the terms the ticket used. */
  defect: string;
  file: string;
  find: string | RegExp;
  replace: string;
  /** The guard check that must be the FIRST to go red. */
  expect: string;
};

type GuardRun = { code: number; labels: string[]; output: string };

function parseLabels(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => /^\s*ok\s{2,}(.+)$/.exec(line)?.[1]?.trim())
    .filter((label): label is string => Boolean(label));
}

function runGuard(guard: string): GuardRun {
  try {
    const output = execFileSync(process.execPath, [TSX_CLI, guard], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, labels: parseLabels(output), output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    return { code: err.status ?? 1, labels: parseLabels(output), output };
  }
}

function applyMutation(m: Mutation): string {
  const original = readFileSync(m.file, 'utf8');
  const mutated = original.replace(m.find as string, m.replace);
  // A mutation that does not apply is the most dangerous outcome: the guard stays green and
  // the matrix reports a pass it never earned.
  if (mutated === original) {
    throw new Error(
      `${m.id}: target text not found in ${m.file}. The mutation is stale — fix it rather ` +
      `than deleting it, or this row proves nothing.`,
    );
  }
  writeFileSync(m.file, mutated);
  return original;
}

/**
 * Run the matrix. Returns the process exit code; every touched file is restored in a
 * `finally` block, including on an unexpected throw.
 */
export function runMutationMatrix(options: {
  title: string;
  guard: string;
  mutations: readonly Mutation[];
}): number {
  const { title, guard, mutations } = options;
  console.log(`${title}\n`);

  const clean = runGuard(guard);
  if (clean.code !== 0) {
    console.error('The guard is not green on a clean tree. Aborting — nothing below would mean anything.');
    console.error(clean.output);
    return 1;
  }
  console.log(`baseline: guard green, ${clean.labels.length} checks\n`);

  const results: Array<{ m: Mutation; verdict: string; detail: string }> = [];

  for (const m of mutations) {
    let original: string | null = null;
    try {
      original = applyMutation(m);
      const run = runGuard(guard);

      if (run.code === 0) {
        results.push({
          m,
          verdict: 'SURVIVED',
          detail: 'the guard stayed GREEN with the defect present — this check does not defend the code',
        });
        continue;
      }

      const firstAbsent = clean.labels.find((label) => !run.labels.includes(label)) ?? '(none)';
      results.push(
        firstAbsent === m.expect
          ? { m, verdict: 'CAUGHT', detail: `first red check: ${firstAbsent}` }
          : { m, verdict: 'WRONG REASON', detail: `expected first red at "${m.expect}", got "${firstAbsent}"` },
      );
    } finally {
      if (original !== null) writeFileSync(m.file, original);
    }
  }

  for (const r of results) {
    console.log(`  ${r.verdict === 'CAUGHT' ? 'ok  ' : 'FAIL'} ${r.m.id.padEnd(4)} ${r.verdict.padEnd(12)} ${r.m.defect}`);
    if (r.verdict !== 'CAUGHT') console.log(`       ${r.detail}`);
  }

  const restored = runGuard(guard);
  console.log(`\nrestored: guard ${restored.code === 0 ? 'green' : 'RED'}, ${restored.labels.length} checks`);
  if (restored.code !== 0) {
    console.error('The tree did not restore cleanly. Check git status before trusting anything above.');
    return 1;
  }

  const escaped = results.filter((r) => r.verdict !== 'CAUGHT');
  if (escaped.length > 0) {
    console.error(`\n${escaped.length} of ${mutations.length} mutations were not caught for the intended reason.`);
    return 1;
  }
  console.log(`\nAll ${mutations.length} mutations caught, each by the check that owns it.`);
  return 0;
}
