/**
 * PS-466: the ONE grammar for the cutover pause value.
 *
 * This module exists because there were briefly two: a Zod `superRefine` in `src/lib/env.ts`
 * and a hand-written `parsePauseValue()` beside the runtime check. Production used the Zod
 * one; the tests exercised the other. A mutation that loosened only the Zod schema would have
 * left production failing open with the suite still green — the exact right-result-wrong-
 * authority problem this card has spent its whole life removing.
 *
 * Dependency-free on purpose, so `env.ts` can call it inside its transform without an import
 * cycle, and a test can exercise the real rule rather than a copy of it.
 *
 * ── The contract ──────────────────────────────────────────────────────────────────────────
 *
 *   undefined              active   — the normal production state, variable absent entirely
 *   'false'                active   — explicit off
 *   'true'                 paused
 *   '' or whitespace       INVALID  — a PRESENT blank is not absent
 *   anything else          INVALID
 *
 * A present blank is treated as a configuration failure rather than as "off". It is a
 * plausible way to write a misconfigured cutover variable — a cleared value in a dashboard,
 * an empty substitution in a deploy template — and on a safety control the operator would
 * believe automation was paused while it kept running.
 *
 * Case and surrounding whitespace are tolerated on the two legal values only.
 */

export const AUTOMATION_EXECUTION_PAUSED_ENV = 'AUTOMATION_EXECUTION_PAUSED';

export class AutomationExecutionPauseConfigError extends Error {
  constructor(raw: string) {
    super(
      `${AUTOMATION_EXECUTION_PAUSED_ENV} must be exactly 'true' or 'false' when set, got ${JSON.stringify(raw)}`,
    );
    this.name = 'AutomationExecutionPauseConfigError';
  }
}

export function parseAutomationExecutionPaused(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new AutomationExecutionPauseConfigError(raw);
}
