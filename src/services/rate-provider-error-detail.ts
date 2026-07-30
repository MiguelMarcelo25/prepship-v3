// PS-473: keep the provider's OWN words next to our sanitized category.
//
// 2026-07-30. A HUGRAB HU-10 order with an active hazmat declaration was
// filtered (correctly) to the single certified carrier, Stamps.com USPS, and
// that request came back:
//
//   {"error": "Carrier rate request failed", "status": "failed",
//    "retryable": false, "transient": false, "durationMs": 362}
//
// "Carrier rate request failed" is OUR string -- the terminal fallthrough in
// sanitizeRateProviderError, which maps provider errors onto a small fixed set
// so provider internals never leak into operator/client-visible diagnostics.
// That sanitizer is doing its job and is deliberately left alone.
//
// The cost is that a hard, non-retryable provider rejection is indistinguishable
// from any other failure. We could not tell whether USPS refuses dangerous goods
// on this service outright, or whether our hazmat payload uses fields their API
// rejects -- two problems with completely different fixes.
//
// So this ADDS a second, narrower channel: the provider's real text, with
// credentials scrubbed and length capped. Diagnostic-only. Nothing reads it to
// make a decision; it exists so the next failure is legible on sight.

/**
 * Redactions applied before any provider text is persisted. Ordered: the
 * labelled-secret pass runs first so "api_key: abc123" keeps its label and
 * loses only the value, rather than the generic long-token pass eating both.
 */
const REDACTIONS: Array<readonly [RegExp, string]> = [
  // scheme://user:pass@host
  [/\/\/[^\s/@]+:[^\s/@]+@/g, '//[redacted]@'],
  // key: value / key=value for anything that names a credential
  [
    /\b(api[-_ ]?key|authorization|bearer|token|secret|password|passwd|credential)\b\s*[:=]\s*\S+/gi,
    '$1=[redacted]',
  ],
  // "Bearer eyJ..." with no separator
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, '[redacted-email]'],
  // Opaque ids/keys: a long unbroken alphanumeric run. Real error prose has
  // spaces, so this hits tokens rather than sentences.
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]'],
];

/**
 * The provider's own error text, scrubbed and capped, for diagnostics only.
 *
 * Returns undefined when there is nothing useful to add, so callers can spread
 * it conditionally and absent stays absent in stored JSON.
 */
export function rateProviderErrorDetail(
  error: unknown,
  maxLength = 400,
): string | undefined {
  const raw = error instanceof Error
    ? (error.message || error.name)
    : typeof error === 'string'
      ? error
      : error == null
        ? ''
        : safeStringify(error);

  let text = String(raw ?? '');
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Circular or otherwise unserialisable -- a failure to describe the error
    // must never become a second error on the rating path.
    return '';
  }
}
