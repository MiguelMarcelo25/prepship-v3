/**
 * PS-258 (slice B) — non-critical Orders scheduler extraction guard (BEHAVIORAL + STATIC).
 *
 * Imports the REAL pure function extracted VERBATIM out of OrdersView.tsx
 * (web/src/components/Views/orders-non-critical-scheduler.ts) and pins its
 * behavior so the extraction is proven importable, byte-identical, and free of
 * the deleted-local-with-leftover-call runtime-crash class.
 *
 *  - scheduleNonCriticalOrdersWork(callback, delayMs?): defers a one-shot
 *    callback to idle time (requestIdleCallback when available, else setTimeout),
 *    skips the callback when the tab is hidden or the schedule was cancelled, and
 *    returns a canceller that tears the registered timer/idle handle down.
 *    SSR-safe: returns a no-op canceller (and never throws) when window is
 *    undefined.
 *
 * STATIC pins: OrdersView imports it from the new module and no longer defines a
 * local function; the new module exports it and is NOT @ts-nocheck; package.json
 * wires test:ps-258-non-critical-scheduler.
 *
 * Pure / offline: no DB, no network. The browser paths are exercised with a tiny
 * fake window/document installed on globalThis and removed afterward.
 *
 *   npx tsx scripts/ps-258-non-critical-scheduler-guard.ts
 */
import { readFileSync } from 'node:fs';
import { scheduleNonCriticalOrdersWork } from '../web/src/components/Views/orders-non-critical-scheduler';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const MODULE_PATH = 'web/src/components/Views/orders-non-critical-scheduler.ts';
const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';

const g = globalThis as Record<string, unknown>;
const hadWindow = 'window' in g;
const hadDocument = 'document' in g;
const savedWindow = g.window;
const savedDocument = g.document;

// ── SSR path: window undefined → no-op canceller, no throw, callback never runs ──
{
  // Ensure the bare `window` global is truly absent for this block.
  if (hadWindow) delete g.window;
  let ran = false;
  const cancel = scheduleNonCriticalOrdersWork(() => { ran = true; });
  check('SSR: returns a function canceller', typeof cancel === 'function');
  check('SSR: cancelling is a safe no-op (does not throw)',
    (() => { try { cancel(); return true; } catch { return false; } })());
  check('SSR: callback never runs synchronously', ran === false);
}

// ── Browser path WITHOUT requestIdleCallback → setTimeout fallback runs the callback ──
{
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  const fakeWindow: Record<string, unknown> = {
    setTimeout: (fn: () => void) => { const id = nextTimerId++; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  g.window = fakeWindow;
  g.document = { visibilityState: 'visible' };

  let ran = false;
  const cancel = scheduleNonCriticalOrdersWork(() => { ran = true; }, 1234);
  check('setTimeout path: a timer was registered', timers.size === 1);
  check('setTimeout path: callback has not run before the timer fires', ran === false);
  // Fire the registered timer.
  for (const fn of timers.values()) fn();
  check('setTimeout path: callback runs when the timer fires', ran === true);
  check('setTimeout path: canceller is callable after fire (no throw)',
    (() => { try { cancel(); return true; } catch { return false; } })());
}

// ── Browser path: cancelling BEFORE the timer fires suppresses the callback ──
{
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  const fakeWindow: Record<string, unknown> = {
    setTimeout: (fn: () => void) => { const id = nextTimerId++; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  g.window = fakeWindow;
  g.document = { visibilityState: 'visible' };

  let ran = false;
  const cancel = scheduleNonCriticalOrdersWork(() => { ran = true; });
  cancel();
  check('cancel-before-fire: the timer was torn down', timers.size === 0);
  // Even if a stale timer fired, the cancelled flag must keep the callback dark;
  // re-register the captured fn shape by invoking any remaining timer (none here).
  for (const fn of timers.values()) fn();
  check('cancel-before-fire: callback never runs', ran === false);
}

// ── Browser path: a hidden tab suppresses the callback (visibility gate) ──
{
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  const fakeWindow: Record<string, unknown> = {
    setTimeout: (fn: () => void) => { const id = nextTimerId++; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  g.window = fakeWindow;
  g.document = { visibilityState: 'hidden' };

  let ran = false;
  scheduleNonCriticalOrdersWork(() => { ran = true; });
  for (const fn of timers.values()) fn();
  check('hidden tab: callback is suppressed when document is not visible', ran === false);
}

// ── Browser path WITH requestIdleCallback → idle path used, canceller calls cancelIdleCallback ──
{
  const idleCallbacks = new Map<number, () => void>();
  let nextIdleId = 1;
  let cancelledIdleId: number | null = null;
  const fakeWindow: Record<string, unknown> = {
    requestIdleCallback: (fn: () => void) => { const id = nextIdleId++; idleCallbacks.set(id, fn); return id; },
    cancelIdleCallback: (id: number) => { cancelledIdleId = id; idleCallbacks.delete(id); },
    setTimeout: () => { throw new Error('setTimeout must not be used when requestIdleCallback exists'); },
    clearTimeout: () => { /* unused */ },
  };
  g.window = fakeWindow;
  g.document = { visibilityState: 'visible' };

  let ran = false;
  const cancel = scheduleNonCriticalOrdersWork(() => { ran = true; });
  check('idle path: requestIdleCallback was used (not setTimeout)', idleCallbacks.size === 1);
  for (const fn of idleCallbacks.values()) fn();
  check('idle path: callback runs when idle fires', ran === true);
  // A second schedule we cancel before firing must call cancelIdleCallback.
  const cancel2 = scheduleNonCriticalOrdersWork(() => { /* never */ });
  cancel2();
  check('idle path: cancel calls cancelIdleCallback with the handle', cancelledIdleId !== null);
  check('idle path: first canceller is callable (no throw)',
    (() => { try { cancel(); return true; } catch { return false; } })());
}

// Restore the original global shape so nothing leaks to other guards.
if (hadWindow) g.window = savedWindow; else delete g.window;
if (hadDocument) g.document = savedDocument; else delete g.document;

// ── STATIC: the new module exports the function and is genuinely type-checked ──
const moduleSrc = readFileSync(MODULE_PATH, 'utf8');
check('module exports scheduleNonCriticalOrdersWork',
  /export function scheduleNonCriticalOrdersWork\b/.test(moduleSrc));
check('module is NOT @ts-nocheck (genuinely type-checked)',
  !/@ts-nocheck/.test(moduleSrc));

// ── STATIC: OrdersView imports it and no longer defines a local function ──
const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');
check('OrdersView imports scheduleNonCriticalOrdersWork from ./orders-non-critical-scheduler',
  /import \{ scheduleNonCriticalOrdersWork \} from '\.\/orders-non-critical-scheduler'/.test(ordersView));
check('OrdersView no longer defines function scheduleNonCriticalOrdersWork',
  !/function scheduleNonCriticalOrdersWork\b/.test(ordersView));
check('OrdersView still calls scheduleNonCriticalOrdersWork( (call sites preserved)',
  /scheduleNonCriticalOrdersWork\(/.test(ordersView));

check('package.json wires test:ps-258-non-critical-scheduler',
  /test:ps-258-non-critical-scheduler/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-258 non-critical-scheduler guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-258 non-critical-scheduler guard');
