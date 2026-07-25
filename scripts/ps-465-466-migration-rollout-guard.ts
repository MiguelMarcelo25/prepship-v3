import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const operator = readFileSync('scripts/apply-ps-465-466-migrations.ts', 'utf8');
const workflow = readFileSync('.github/workflows/render-one-off-migration-ps465-466.yml', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const confirmation = 'apply-ps-465-466-hazmat-automations-0078-0081';

assert.match(operator, new RegExp(`--confirm=\\$\\{CONFIRMATION\\}`));
assert.match(operator, /client\.begin/);
assert.match(operator, /pg_advisory_xact_lock/);
assert.match(operator, /orders_shipments_unchanged=true/);
assert.match(operator, /labels_postage_provider_calls=0/);
assert.match(operator, /protected order\/shipment mutation detected/);
assert.match(operator, /delete\\s\+from\\s\+\(\?:public/);
for (const migration of ['0078_order_hazmat_declarations.sql', '0079_ps466_automations_engine.sql',
  '0080_ps466_automation_recovery_leases.sql', '0081_ps466_automation_shipping_controls.sql']) {
  assert.match(operator, new RegExp(migration.replace('.', '\\.')));
  assert.match(workflow, new RegExp(migration.replace('.', '\\.')));
}

assert.match(workflow, new RegExp(confirmation));
assert.match(workflow, /workflow_dispatch/);
assert.match(workflow, /\/jobs/);
assert.match(workflow, /tar -czf -/);
assert.match(workflow, /base64 -d \| tar -xzf -/);
assert.match(workflow, /case "\$status" in[\s\S]*succeeded\)/);
assert.match(packageJson, /"migrate:ps-465-466-rollout"/);
assert.match(packageJson, /"test:ps-465-466-migration-rollout"/);

console.log('PS-465/466 confirmation-gated Render migration rollout guard passed');
