import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mainPath = path.join(root, 'src/main.ts');
const workerPath = path.join(root, 'src/worker.ts');
const planPath = path.join(root, 'AWAITING_SHIPMENTS_PERFORMANCE_PLAN.md');
const readmePath = path.join(root, 'DEV_TASKS_README.md');
const packagePath = path.join(root, 'package.json');

const main = fs.readFileSync(mainPath, 'utf8');
const worker = fs.readFileSync(workerPath, 'utf8');
const plan = fs.readFileSync(planPath, 'utf8');
const readme = fs.readFileSync(readmePath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

assert(
  pkg.scripts?.['test:orders-maintenance-startup'] === 'node scripts/orders-maintenance-startup-guard.mjs',
  'package.json exposes test:orders-maintenance-startup',
);

for (const [name, source] of [
  ['API runtime', main],
  ['worker runtime', worker],
]) {
  assert(
    source.includes('env.RUN_ORDERS_PERFORMANCE_MAINTENANCE === true'),
    `${name} requires explicit RUN_ORDERS_PERFORMANCE_MAINTENANCE=true`,
  );
  assert(
    !source.includes('env.RUN_ORDERS_PERFORMANCE_MAINTENANCE ?? env.RUN_SYNC_SCHEDULER'),
    `${name} does not implicitly run maintenance from RUN_SYNC_SCHEDULER`,
  );
}

assert(
  plan.includes('explicit opt-in') &&
    plan.includes('RUN_ORDERS_PERFORMANCE_MAINTENANCE=true') &&
    plan.includes('must stay disabled on the user-facing API'),
  'Awaiting performance plan documents explicit opt-in startup maintenance policy',
);

assert(
  readme.includes('orders performance maintenance is now explicit opt-in') &&
    readme.includes('RUN_ORDERS_PERFORMANCE_MAINTENANCE=true'),
  'Phase tracker documents the explicit opt-in maintenance change',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
