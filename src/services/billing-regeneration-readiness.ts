export const BILLING_REGENERATION_BLOCKED_CODE = 'BILLING_REGENERATION_BLOCKED';

// Per user override unlock shipped data on 2026-07-11: PS-416 protects
// regeneration of billing derived from shipped-order money sources.

/**
 * Canonical fail-closed boundary for Billing regeneration prerequisites.
 * A money/freshness read that cannot be verified must never be converted into
 * an empty/default value, because that could replace correct frozen rows with
 * a different bill.
 */
export class BillingRegenerationBlockedError extends Error {
  readonly code = BILLING_REGENERATION_BLOCKED_CODE;
  readonly regenerationAllowed = false;
  readonly source: string;

  constructor(source: string, options?: { cause?: unknown }) {
    super(
      `Billing regeneration blocked because ${source} could not be verified. No billing lines were changed.`,
      options,
    );
    this.name = 'BillingRegenerationBlockedError';
    this.source = source;
  }
}

export function isBillingRegenerationBlockedError(
  error: unknown,
): error is BillingRegenerationBlockedError {
  return error instanceof BillingRegenerationBlockedError;
}

/** Thin direct delegate: preserves the canonical loader and only adds fail-closed semantics. */
export async function requireBillingRegenerationRead<T>(
  source: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isBillingRegenerationBlockedError(error)) throw error;
    throw new BillingRegenerationBlockedError(source, { cause: error });
  }
}
