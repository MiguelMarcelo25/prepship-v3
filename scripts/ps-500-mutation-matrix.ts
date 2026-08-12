#!/usr/bin/env tsx
/**
 * PS-500 — mutation matrix for the rate-money guard.
 *
 * A guard passing against correct code proves nothing. It proves something only
 * if it goes RED when the defect is put back, and red for the RIGHT reason.
 *
 * This reintroduces each defect PS-500 removed, one at a time, and requires the
 * guard to fail at the specific check that owns it. "Some check failed" is not
 * good enough: a mutation that trips an unrelated assertion would let a bare
 * spot hide behind a neighbour.
 *
 * How the reason is verified: the guard prints `  ok  <label>` per passing
 * check. A clean run gives the canonical ordered label list. Under a mutation,
 * the FIRST absent label must be exactly the one that owns the defect.
 *
 * This found a real hole. Before it was written the guard had 28 green checks
 * and `rateBlockedReason` could be stripped of its money check entirely with the
 * pack still green — the fix from the previous corrective pass was documented by
 * the guard, not defended by it.
 *
 * Every file is restored in a finally block. Run it on a clean tree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const GUARD = 'scripts/ps-500-rate-money-classifier-guard.ts';
/**
 * tsx's entry, run under this same node binary. Not `npx`: that resolves to a
 * `.cmd` shim on Windows, which node refuses to spawn without a shell, and
 * enabling the shell concatenates arguments instead of escaping them.
 */
const TSX_CLI = 'node_modules/tsx/dist/cli.mjs';

const CLASSIFIER = 'src/services/shipping-workflow/shipping-rate-money-classifier.ts';
const BROWSE = 'src/services/rate-browser-display-fields.ts';
const MODAL = 'web/src/components/RateBrowserModal.tsx';

type Mutation = {
  id: string;
  /** The defect being put back, in the terms the ticket used. */
  defect: string;
  file: string;
  find: string | RegExp;
  replace: string;
  /** The guard check that must be the first to go red. */
  expect: string;
};

const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    defect: 'browse boundary stamps a verdict it did not compute',
    file: BROWSE,
    find: 'rateMoneyComplete: moneyVerdict.rateMoneyComplete,',
    replace: 'rateMoneyComplete: true,',
    expect: 'the browse producer stamps the verdict on a live row',
  },
  {
    id: 'M2',
    defect: 'browse boundary carries no verdict at all (the original FAIL)',
    file: BROWSE,
    find: /return \{\r?\n\s*\.\.\.stamped,\r?\n[\s\S]*?\r?\n\s*\};/,
    replace: 'return stamped;',
    expect: 'the browse producer stamps the verdict on a live row',
  },
  {
    id: 'M3',
    defect: 'availability computes the money reason and discards it',
    file: MODAL,
    find: 'if (moneyReason) return moneyReason;',
    replace: 'void moneyReason;',
    expect: 'availability consults the money verdict FIRST',
  },
  {
    id: 'M4',
    defect: 'manual Apply stops gating on availability',
    file: MODAL,
    find: 'if (isBackendUnavailableRate(r, order, currentRateShippingOptions)) return;',
    replace: 'void isBackendUnavailableRate(r, order, currentRateShippingOptions);',
    expect: 'every emitting path gates on that one boundary',
  },
  {
    id: 'M4b',
    defect: 'auto-best emission stops gating on availability',
    file: MODAL,
    find: 'if (isBackendUnavailableRate(r, order, currentRateShippingOptions)) return null;',
    replace: 'void isBackendUnavailableRate(r, order, currentRateShippingOptions);',
    expect: 'every emitting path gates on that one boundary',
  },
  {
    id: 'M4c',
    defect: 'the gate stops delegating to the reason owner that reads the verdict',
    file: MODAL,
    find: 'return rateBlockedReason(rate, order, shippingOptions) != null;',
    replace: 'return false;',
    expect: 'the availability boundary is the one the gate calls',
  },
  {
    id: 'M5',
    defect: 'the persisted seed accepts incomplete money',
    file: MODAL,
    find: 'if (!rateMoneyIsComplete(bestRate)) return null;',
    replace: 'void rateMoneyIsComplete(bestRate);',
    expect: 'the seed refuses incomplete money before building a row',
  },
  {
    id: 'M6',
    defect: 'a TOTAL is accepted as the shipment COMPONENT (the headline defect)',
    file: CLASSIFIER,
    find: "const SHIPMENT_COST_KEYS = ['shipmentCost', 'shipment_cost'] as const;",
    replace: "const SHIPMENT_COST_KEYS = ['shipmentCost', 'shipment_cost', 'amount'] as const;",
    expect: '`amount` alone NEVER satisfies the shipment component',
  },
  {
    id: 'M7',
    defect: 'a total contradicting its components is no longer surfaced',
    file: CLASSIFIER,
    find: "return fail(shipmentCost, otherCost, 'total_contradicts_components');",
    replace: '/* contradiction ignored */',
    expect: 'an explicit total contradicting its components fails closed',
  },
  {
    id: 'M8',
    defect: 'absent add-ons silently become $0.00 again',
    file: CLASSIFIER,
    find: "return fail(shipmentCost, otherCost, 'other_cost_absent');",
    replace: 'otherCost.value = 0;',
    expect: 'absent otherCost is ABSENT, never zero',
  },
];

type GuardRun = { code: number; labels: string[]; output: string };

function runGuard(): GuardRun {
  try {
    const output = execFileSync(process.execPath, [TSX_CLI, GUARD], {
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

function parseLabels(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('  ok  '))
    .map((line) => line.slice(6).trim());
}

function applyMutation(m: Mutation): string {
  const original = readFileSync(m.file, 'utf8');
  const mutated = typeof m.find === 'string'
    ? original.replace(m.find, m.replace)
    : original.replace(m.find, m.replace);
  // A mutation that does not apply is the most dangerous outcome: the guard
  // stays green and the matrix reports a pass it never earned.
  if (mutated === original) {
    throw new Error(
      `${m.id}: target text not found in ${m.file}. The mutation is stale — ` +
      `fix it rather than deleting it, or this row proves nothing.`,
    );
  }
  writeFileSync(m.file, mutated);
  return original;
}

console.log('PS-500 mutation matrix\n');

const clean = runGuard();
if (clean.code !== 0) {
  console.error('The guard is not green on a clean tree. Aborting — nothing below would mean anything.');
  console.error(clean.output);
  process.exit(1);
}
console.log(`baseline: guard green, ${clean.labels.length} checks\n`);

const results: Array<{ m: Mutation; verdict: string; detail: string }> = [];

for (const m of MUTATIONS) {
  let original: string | null = null;
  try {
    original = applyMutation(m);
    const run = runGuard();

    if (run.code === 0) {
      results.push({
        m,
        verdict: 'SURVIVED',
        detail: 'the guard stayed GREEN with the defect present — this check does not defend the code',
      });
      continue;
    }

    // Red for the RIGHT reason: the first label the clean run produced that this
    // run did not is the check that actually caught it.
    const firstAbsent = clean.labels.find((label) => !run.labels.includes(label)) ?? '(none)';
    results.push(
      firstAbsent === m.expect
        ? { m, verdict: 'CAUGHT', detail: `first red check: ${firstAbsent}` }
        : {
            m,
            verdict: 'WRONG REASON',
            detail: `expected first red at "${m.expect}", got "${firstAbsent}"`,
          },
    );
  } finally {
    if (original !== null) writeFileSync(m.file, original);
  }
}

for (const r of results) {
  const mark = r.verdict === 'CAUGHT' ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${r.m.id}  ${r.verdict.padEnd(12)} ${r.m.defect}`);
  if (r.verdict !== 'CAUGHT') console.log(`       ${r.detail}`);
}

const restored = runGuard();
console.log(`\nrestored: guard ${restored.code === 0 ? 'green' : 'RED'}, ${restored.labels.length} checks`);
if (restored.code !== 0) {
  console.error('The tree did not restore cleanly. Check git status before trusting anything above.');
  process.exit(1);
}

const escaped = results.filter((r) => r.verdict !== 'CAUGHT');
if (escaped.length > 0) {
  console.error(`\n${escaped.length} of ${MUTATIONS.length} mutations were not caught for the intended reason.`);
  process.exit(1);
}
console.log(`\nAll ${MUTATIONS.length} mutations caught, each by the check that owns it.`);
