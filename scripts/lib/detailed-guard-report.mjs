export function createGuardReport({ title, bug, scope }) {
  const checks = [];

  function check({ name, condition, why, evidence, failure, fix }) {
    const passed = Boolean(condition);
    checks.push({ name, passed, why, evidence, failure, fix });

    console.log(`\n[${passed ? 'PASS' : 'FAIL'}] ${name}`);
    console.log(`  Why this matters: ${why}`);
    console.log(`  Evidence checked: ${evidence}`);

    if (!passed) {
      console.log(`  What is wrong: ${failure}`);
      console.log(`  How to fix it: ${fix}`);
      process.exitCode = 1;
    }
  }

  function finish() {
    const passed = checks.filter((entry) => entry.passed).length;
    const failed = checks.length - passed;

    console.log(`\n=== ${title} ===`);
    console.log(`Bug guarded: ${bug}`);
    if (scope) console.log(`Scope: ${scope}`);
    console.log(`Checks: ${passed}/${checks.length} passed, ${failed} failed`);

    if (failed > 0) {
      console.log('\nFailing checks:');
      for (const entry of checks.filter((item) => !item.passed)) {
        console.log(`- ${entry.name}: ${entry.failure}`);
        console.log(`  Fix: ${entry.fix}`);
      }
      process.exit(process.exitCode ?? 1);
    }

    console.log('Result: guarded bug behavior is present.');
  }

  return { check, finish };
}
