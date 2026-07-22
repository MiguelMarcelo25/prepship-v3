export class LabelArtifactMissingAfterPurchaseError extends Error {
  readonly code = 'LABEL_ARTIFACT_MISSING_AFTER_PURCHASE' as const;

  constructor(provider: string) {
    super(
      `${provider} accepted the label purchase but did not return a usable label artifact. ` +
      'The provider receipt is held for reconciliation and must not be purchased again.',
    );
    this.name = 'LabelArtifactMissingAfterPurchaseError';
  }
}

export function assertPurchasedLabelArtifact(
  provider: string,
  labelUrl: unknown,
): asserts labelUrl is string {
  if (
    typeof labelUrl !== 'string'
    || !labelUrl.trim()
    || labelUrl.trim() === '[object Object]'
  ) {
    throw new LabelArtifactMissingAfterPurchaseError(provider);
  }
}
