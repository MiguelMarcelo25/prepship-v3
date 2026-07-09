export type RateBrowseExecutionPriority = 'interactive' | 'background';

export type RateBrowseProviderExecutionPolicy = {
  timeoutMs: number;
  maxRetries: number;
};

export const RATE_BROWSE_INTERACTIVE_PROVIDER_TIMEOUT_MS = Math.min(
  10_000,
  Math.max(
    3_000,
    Number.parseInt(process.env.RATE_BROWSE_INTERACTIVE_PROVIDER_TIMEOUT_MS ?? '8000', 10) || 8_000,
  ),
);

export function resolveRateBrowseProviderExecutionPolicy(input: {
  priority: RateBrowseExecutionPriority;
  defaultTimeoutMs: number;
  defaultMaxRetries: number;
}): RateBrowseProviderExecutionPolicy {
  if (input.priority === 'interactive') {
    return {
      timeoutMs: RATE_BROWSE_INTERACTIVE_PROVIDER_TIMEOUT_MS,
      maxRetries: 0,
    };
  }
  return {
    timeoutMs: Math.max(1, input.defaultTimeoutMs),
    maxRetries: Math.max(0, input.defaultMaxRetries),
  };
}

export function estimateRateBrowseFanoutBudgetMs(input: {
  providerCount: number;
  concurrency: number;
  policy: RateBrowseProviderExecutionPolicy;
}): number {
  const providerCount = Math.max(0, Math.floor(input.providerCount));
  const concurrency = Math.max(1, Math.floor(input.concurrency));
  const waves = Math.ceil(providerCount / concurrency);
  return waves * input.policy.timeoutMs * (input.policy.maxRetries + 1);
}
