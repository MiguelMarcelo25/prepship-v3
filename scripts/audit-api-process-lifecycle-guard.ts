import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createApiProcessLifecycle,
  type ApiProcessServer,
} from '../src/services/api-process-lifecycle';

class FakeServer implements ApiProcessServer {
  closeCalls = 0;
  closeIdleCalls = 0;
  closeAllCalls = 0;
  closeCallback: ((error?: Error) => void) | null = null;

  close(callback?: (error?: Error) => void): void {
    this.closeCalls += 1;
    this.closeCallback = callback ?? null;
  }

  closeIdleConnections(): void {
    this.closeIdleCalls += 1;
  }

  closeAllConnections(): void {
    this.closeAllCalls += 1;
  }
}

const exitCodes: number[] = [];
const signalServer = new FakeServer();
const signalLifecycle = createApiProcessLifecycle({
  server: signalServer,
  shutdownTimeoutMs: 100,
  uncaughtFailureLimit: 3,
  exit: (code) => exitCodes.push(code),
});

signalLifecycle.shutdown('SIGTERM');
signalLifecycle.shutdown('SIGINT');
assert.equal(signalServer.closeCalls, 1, 'duplicate signals share one shutdown');
assert.equal(signalServer.closeIdleCalls, 1, 'shutdown closes idle connections immediately');
assert.deepEqual(exitCodes, [], 'active requests may drain before exit');
signalServer.closeCallback?.();
assert.deepEqual(exitCodes, [0], 'clean drain exits successfully');

const breakerExitCodes: number[] = [];
const breakerServer = new FakeServer();
const breakerLifecycle = createApiProcessLifecycle({
  server: breakerServer,
  shutdownTimeoutMs: 100,
  uncaughtFailureLimit: 3,
  exit: (code) => breakerExitCodes.push(code),
});

breakerLifecycle.recordUncaughtFailure('unhandled_rejection', new Error('first'));
breakerLifecycle.recordUncaughtFailure('uncaught_exception', new Error('second'));
assert.equal(breakerServer.closeCalls, 0, 'failures below the limit remain observable but non-fatal');
breakerLifecycle.recordUncaughtFailure('uncaught_exception', new Error('third'));
assert.equal(breakerServer.closeCalls, 1, 'the configured failure limit opens the breaker');
breakerServer.closeCallback?.();
assert.deepEqual(breakerExitCodes, [1], 'breaker drain exits non-zero for supervisor restart');

const timeoutExitCodes: number[] = [];
const timeoutServer = new FakeServer();
const timeoutLifecycle = createApiProcessLifecycle({
  server: timeoutServer,
  shutdownTimeoutMs: 5,
  uncaughtFailureLimit: 3,
  exit: (code) => timeoutExitCodes.push(code),
});
timeoutLifecycle.shutdown('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(timeoutServer.closeAllCalls, 1, 'expired drain force-closes remaining connections');
assert.deepEqual(timeoutExitCodes, [1], 'expired drain exits non-zero');

const main = readFileSync('src/main.ts', 'utf8');
const env = readFileSync('src/lib/env.ts', 'utf8');
const lifecycle = readFileSync('src/services/api-process-lifecycle.ts', 'utf8');
const doc = readFileSync('docs/ps-tickets/audit-4.6-api-process-lifecycle.md', 'utf8');

assert.match(main, /const server = serve\(/, 'main retains the listening server');
assert.match(main, /createApiProcessLifecycle\(\{[\s\S]{0,240}server/, 'main delegates lifecycle policy');
assert.match(main, /process\.once\('SIGTERM',[\s\S]{0,120}lifecycle\.shutdown/, 'SIGTERM drains');
assert.match(main, /process\.once\('SIGINT',[\s\S]{0,120}lifecycle\.shutdown/, 'SIGINT drains');
assert.equal(
  (main.match(/lifecycle\.recordUncaughtFailure\(/g) ?? []).length,
  2,
  'both escaped-error events delegate to the breaker',
);
assert.match(env, /API_GRACEFUL_SHUTDOWN_TIMEOUT_MS:[\s\S]{0,100}default\(25_000\)/);
assert.match(env, /API_UNCAUGHT_FAILURE_LIMIT:[\s\S]{0,100}default\(3\)/);
assert.match(lifecycle, /server\.close\(/, 'owner stops new HTTP admission');
assert.match(lifecycle, /server\.closeAllConnections\?\.\(\)/, 'owner enforces the drain deadline');

for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(doc.includes(field), `placement record includes ${field}`);
}

console.log('PASS Audit 4.6 API process lifecycle guard');
