import { env } from '../../lib/env.js';

/**
 * PS-466 cutover control: no new automation evaluation may BEGIN while paused.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────────
 *
 * The fenced runtime protects new-binary workers from one another. It cannot fence a process
 * still running the OLD binary: an old `finish()` updates by run id with no token predicate,
 * and an old `claimEffect()` has no parent-run fence. So during a rolling deploy an old
 * process can overwrite a run the new code has already reclaimed, and can still enter a
 * handler.
 *
 * Stopping the worker is not a drain. `stopAutomationOutboxWorker()` clears its interval and
 * returns; it never awaits the pump already running. And the worker is started alongside the
 * queued-sync scheduler and rate-browse worker, so disabling that process turns off far more
 * than automation.
 *
 * This converts the dangerous moment from "old and new binaries may both execute automation"
 * into "old binaries roll away while new binaries refuse to start any automation at all".
 *
 * ── Deliberately ONE control, not a set of fencing flags ──────────────────────────────────
 *
 * A "fencing enabled" switch would create states where leases are written but only some
 * fences are enforced — strictly worse than either end. This has exactly one meaning, and it
 * is the one an operator can reason about during a cutover.
 *
 * ── Parsed once, and INVALID VALUES FAIL STARTUP ──────────────────────────────────────────
 *
 * Validation lives in `src/lib/env.ts`, so the value is parsed and checked once rather than
 * re-derived here with a second ad hoc boolean grammar. Two properties follow:
 *
 *   The variable is normally ABSENT, and absent means active. A typo cannot halt production
 *   automation that nobody was trying to pause.
 *
 *   But a PRESENT malformed value — `tru`, `yes`, `1`, `paused` — fails startup rather than
 *   silently reading as active. On a safety control the dangerous failure is an operator
 *   believing automation is paused while it is still executing, and that is exactly what a
 *   fail-open parse produces.
 *
 * One process therefore cannot see two different pause semantics during its lifetime, and the
 * status endpoint reports the same boolean execution uses.
 */

export { AUTOMATION_EXECUTION_PAUSED_ENV, parseAutomationExecutionPaused } from './execution-pause-config.js';

/** Stable, machine-readable. Route mappers key off `AUTOMATION_*` codes. */
export const AUTOMATION_EXECUTION_PAUSED_CODE = 'AUTOMATION_EXECUTION_PAUSED';

/**
 * Thrown before any run row, handler, carrier selection or postage decision is reached.
 *
 * 409 rather than 503: it matches the existing automation preflight family, and it is a
 * deliberate, retryable refusal of this request rather than a claim that the service is
 * unavailable — the API is healthy and answering, it is automation that is deliberately held.
 */
export class AutomationExecutionPausedError extends Error {
  readonly code = AUTOMATION_EXECUTION_PAUSED_CODE;
  readonly status = 409 as const;
  readonly retryable = true;

  constructor() {
    super('Automation execution is paused for cutover');
    this.name = 'AutomationExecutionPausedError';
  }
}

/**
 * The same grammar `src/lib/env.ts` enforces at startup, exported so a test can exercise the
 * real rule instead of a copy. Absent and 'false' are active; 'true' pauses; anything else
 * present is a configuration error and throws.
 */
/** The validated startup value. `override` exists so tests need not mutate process.env. */
export function isAutomationExecutionPaused(override?: boolean): boolean {
  return override ?? env.AUTOMATION_EXECUTION_PAUSED === true;
}

let announced: boolean | null = null;

/** Log the state once per process, so a paused deploy is visible without per-request noise. */
export function announceAutomationExecutionPause(paused = isAutomationExecutionPaused()): void {
  if (announced === paused) return;
  announced = paused;
  console.log(`[automation] execution ${paused ? 'PAUSED (cutover control set)' : 'ACTIVE'}`);
}

/**
 * Fail closed at the point of admission. Callers must invoke this BEFORE claiming outbox work
 * or beginning a run — a pause that only rejected mid-flight would still let the outbox
 * increment attempts on every pass and eventually dead-letter genuine events.
 */
export function assertAutomationExecutionAllowed(): void {
  if (isAutomationExecutionPaused()) {
    announceAutomationExecutionPause(true);
    throw new AutomationExecutionPausedError();
  }
}
