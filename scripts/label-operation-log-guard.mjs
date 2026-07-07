import { existsSync, readFileSync } from 'node:fs';

const checks = [];

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function expect(name, condition) {
  checks.push({ name, condition: Boolean(condition) });
}

const packageJson = read('package.json');
const operationLog = read('src/lib/label-operation-log.ts');
const labelsRoute = read('src/routes/labels.ts');
const printQueueService = read('src/services/print-queue.ts');
const observabilityRoute = read('src/routes/observability.ts');
const home = read('web/src/Home.tsx');

expect(
  'package exposes label operation log guard',
  packageJson.includes('"test:label-operation-log": "node scripts/label-operation-log-guard.mjs"'),
);

expect(
  'backend owns a bounded label operation log',
  operationLog.includes('export type LabelOperationLogEntry') &&
    operationLog.includes('recordLabelOperationLog') &&
    operationLog.includes('getLabelOperationLogSnapshot') &&
    operationLog.includes('deleteLabelOperationLog') &&
    operationLog.includes('clearLabelOperationLogs') &&
    operationLog.includes('MAX_LABEL_OPERATION_LOGS') &&
    operationLog.includes('orderNumber') &&
    operationLog.includes('cause') &&
    operationLog.includes('timingMs'),
);

expect(
  'single label route records success and failure outcomes',
  labelsRoute.includes('recordLabelOperationLog') &&
    labelsRoute.includes("action: 'label_create'") &&
    labelsRoute.includes("status: 'success'") &&
    labelsRoute.includes("status: 'error'"),
);

expect(
  'print queue worker records per-order backend results',
  printQueueService.includes('recordQueueSendResultLogs') &&
    printQueueService.includes('recordLabelOperationLog') &&
    printQueueService.includes("action: 'print_queue'") &&
    printQueueService.includes('job.results'),
);

expect(
  'api timing snapshot exposes label operation logs',
  observabilityRoute.includes('getLabelOperationLogSnapshot') &&
    observabilityRoute.includes('deleteLabelOperationLog') &&
    observabilityRoute.includes('clearLabelOperationLogs') &&
    observabilityRoute.includes('labelOperationLogs') &&
    observabilityRoute.includes("app.get('/api-timing'") &&
    observabilityRoute.includes("app.delete('/label-operation-logs/:id'") &&
    observabilityRoute.includes("app.delete('/label-operation-logs'"),
);

expect(
  'last sync timing modal renders label operation logs',
  home.includes('labelOperationLogs') &&
    home.includes('Label / Queue Logs') &&
    home.includes('Order #') &&
    home.includes('Cause') &&
    home.includes('formatOperationLogStatusTone') &&
    home.includes('handleDeleteLabelOperationLog') &&
    home.includes('handleClearLabelOperationLogs') &&
    home.includes('Clear all') &&
    home.includes('Trash2'),
);

const failed = checks.filter((check) => !check.condition);
if (failed.length) {
  console.error('Label operation log guard failed:');
  for (const check of failed) console.error(`- ${check.name}`);
  process.exit(1);
}

console.log(`Label operation log guard passed (${checks.length} checks).`);
