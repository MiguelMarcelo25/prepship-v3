import { AUTOMATION_EXECUTION_PAUSED_CODE } from './execution-pause.js';

/**
 * PS-466: one place that turns an automation rejection into an HTTP response.
 *
 * There are three synchronous ingresses — the manual evaluation route, Shopify `before_rate`,
 * and both `before_label_purchase` paths. Each previously mapped errors independently, and
 * they drifted: the manual route had an explicit paused case, the label route matched the
 * `AUTOMATION_` prefix, and the rate route had neither and returned a generic HTTP 500.
 *
 * ── Why `kind` exists ─────────────────────────────────────────────────────────────────────
 *
 * The first fix matched the `AUTOMATION_` prefix and logged every hit as a cutover pause. But
 * that prefix covers ordinary preflight rejections too — AUTOMATION_CONFLICT,
 * AUTOMATION_EVALUATION_FAILED, AUTOMATION_ACTION_FAILED and others are all real codes on this
 * path. An automation hold during normal trading would have been recorded as
 * `rate.shopify.automation_paused`, inventing cutover evidence on a day nobody was cutting
 * over. The RESPONSE is the same for both; the EVENT is not, so the caller is told which it
 * has rather than guessing from the code.
 *
 * The status is fixed at 409 and never taken from the error. An error-supplied status is
 * attacker- or bug-controlled input to the response contract, and the automation preflight
 * contract here is 409 regardless of what any individual error happens to carry.
 *
 * Deliberately narrow: this classifies automation rejections only. It is not a general
 * application error framework, and it should not become one.
 */

export type AutomationResponseKind = 'paused' | 'preflight';

export type AutomationResponse = {
  status: 409;
  kind: AutomationResponseKind;
  body: { error: string; code: string; retryable: boolean };
};

/** Returns null when the error is not an automation rejection; the caller keeps its own path. */
export function classifyAutomationResponse(error: unknown): AutomationResponse | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !code.startsWith('AUTOMATION_')) return null;

  const paused = code === AUTOMATION_EXECUTION_PAUSED_CODE;
  return {
    status: 409,
    kind: paused ? 'paused' : 'preflight',
    body: {
      error: error instanceof Error ? error.message : 'Automation preflight rejected the request',
      // A pause is always retryable — it is a held state, not a rejection of the request
      // itself. Other preflight rejections report whatever they claim, defaulting to false.
      retryable: paused ? true : (error as { retryable?: unknown }).retryable === true,
      code,
    },
  };
}
