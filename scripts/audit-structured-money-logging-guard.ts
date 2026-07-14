import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  logStructured,
  reportError,
  runWithLogContext,
} from '../src/lib/structured-log';

const captured = {
  error: [] as string[],
  warn: [] as string[],
  info: [] as string[],
};
const originalConsole = {
  error: console.error,
  warn: console.warn,
  info: console.info,
};

try {
  console.error = (...values: unknown[]) => captured.error.push(values.map(String).join(' '));
  console.warn = (...values: unknown[]) => captured.warn.push(values.map(String).join(' '));
  console.info = (...values: unknown[]) => captured.info.push(values.map(String).join(' '));

  const failure = new TypeError('invoice total failed');
  await runWithLogContext({ requestId: 'req-audit-3-8' }, async () => {
    await Promise.resolve();
    runWithLogContext({ orderId: 3801 }, () => {
      reportError('billing.invoice.failed', failure, { clientId: 38 });
      reportError('billing.invoice.failed_again', failure, { clientId: 38 });
    });
  });

  logStructured('warn', 'money.request.rejected', {
    requestId: 'req-explicit',
    event: 'caller-cannot-replace-event',
    level: 'info',
    timestamp: 'caller-cannot-replace-timestamp',
    status: 409,
  });
} finally {
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.info = originalConsole.info;
}

assert.equal(captured.error.length, 1, 'one Error crossing multiple boundaries must emit once');
const errorLog = JSON.parse(captured.error[0]!) as Record<string, unknown>;
assert.equal(errorLog.level, 'error');
assert.equal(errorLog.event, 'billing.invoice.failed');
assert.equal(errorLog.requestId, 'req-audit-3-8', 'requestId must survive an awaited boundary');
assert.equal(errorLog.orderId, 3801, 'nested money-path context must add orderId');
assert.equal(errorLog.clientId, 38);
assert.equal(errorLog.errorName, 'TypeError');
assert.equal(errorLog.error, 'invoice total failed');
assert.match(String(errorLog.stack), /invoice total failed/);
assert.doesNotThrow(() => new Date(String(errorLog.timestamp)).toISOString());

assert.equal(captured.warn.length, 1);
const warningLog = JSON.parse(captured.warn[0]!) as Record<string, unknown>;
assert.equal(warningLog.level, 'warn', 'caller fields must not replace canonical level');
assert.equal(warningLog.event, 'money.request.rejected', 'caller fields must not replace canonical event');
assert.notEqual(warningLog.timestamp, 'caller-cannot-replace-timestamp');
assert.equal(warningLog.requestId, 'req-explicit');
assert.equal(warningLog.status, 409);

const mainSource = readFileSync('src/main.ts', 'utf8');
const safeErrorSource = readFileSync('src/lib/safe-error.ts', 'utf8');
const billingRouteSource = readFileSync('src/routes/billing.ts', 'utf8');
const billingServiceSource = readFileSync('src/services/billing.ts', 'utf8');
const ratesRouteSource = readFileSync('src/routes/rates.ts', 'utf8');
const rateWorkflowSource = readFileSync('src/services/rate-browse-workflow.ts', 'utf8');
const labelsRouteSource = readFileSync('src/routes/labels.ts', 'utf8');

assert.match(mainSource, /runWithLogContext\(\{ requestId \}, next\)/, 'request middleware must own async request context');
assert.match(mainSource, /reportError\('api\.request\.failed'/, 'global request failures must use the shared sink');
assert.doesNotMatch(mainSource, /console\.error\('\[api:error\]'/, 'global request failures must not keep an ad-hoc log shape');
assert.match(safeErrorSource, /reportError\(scope, err\)/, 'legacy safe-error adapter must stay a thin delegate');

assert.match(billingRouteSource, /billingOrderIdFromPath/, 'order-scoped billing paths must attach orderId');
assert.match(billingRouteSource, /reportError\('billing\.request\.failed'/);
assert.match(billingServiceSource, /reportError\('billing\.summary_metrics\.refresh_failed'/);

assert.match(ratesRouteSource, /runWithLogContext\([\s\S]*?orderId: body\.orderId/);
assert.match(ratesRouteSource, /reportError\('rate\.browse\.failed'/);
assert.match(ratesRouteSource, /reportError\('rate\.shopify\.failed'/);
assert.match(rateWorkflowSource, /reportError\('rate\.browse\.detached_failed'/);

assert.match(labelsRouteSource, /Per user override unlock shipped data on 2026-07-14: observability only/);
assert.match(labelsRouteSource, /runWithLogContext\([\s\S]*?orderId: body\.orderId/);
assert.match(labelsRouteSource, /reportError\('label\.purchase\.failed'/);

console.log('PASS Audit 3.8 structured money-path logging guard');
