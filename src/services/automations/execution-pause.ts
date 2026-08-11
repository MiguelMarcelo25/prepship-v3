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
 * returns; it never awaits the pump that is already running. And the worker is started
 * alongside the queued-sync scheduler and rate-browse worker, so disabling that process turns
 * off far more than automation.
 *
 * This converts the dangerous moment from "old and new binaries may both execute automation"
 * into "old binaries roll away while new binaries refuse to start any automation at all".
 *
 * ── Deliberately ONE control, not a set of fencing flags ──────────────────────────────────
 *
 * A "fencing enabled" switch would create states where leases are written but only some
 * fences are enforced — which is strictly worse than either end. This has exactly one
 * meaning, and it is the one an operator can reason about during a cutover.
 *
 * Default is OFF (not paused). It must be set explicitly for the cutover, and anything other
 * than an explicit affirmative leaves automation running normally — a typo must not silently
 * halt production automation.
 */

export const AUTOMATION_EXECUTION_PAUSED_ENV = 'AUTOMATION_EXECUTION_PAUSED';

/** Thrown before any run row, handler, provider call or postage decision is reached. */
export class AutomationExecutionPausedError extends Error {
  constructor() {
    super('Automation execution is paused for cutover');
    this.name = 'AutomationExecutionPausedError';
  }
}

export function isAutomationExecutionPaused(raw: string | undefined = process.env[AUTOMATION_EXECUTION_PAUSED_ENV]): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
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
