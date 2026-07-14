export type RateBackfillDiagnosticBuffers = {
  skipSamples: string[];
  failureSamples: string[];
};

const SAMPLE_LIMIT = 5;

export function createRateBackfillDiagnosticBuffers(): RateBackfillDiagnosticBuffers {
  return {
    skipSamples: [],
    failureSamples: [],
  };
}

export function recordRateBackfillDiagnostic(
  buffers: RateBackfillDiagnosticBuffers,
  kind: 'skip' | 'failure',
  sample: string,
): void {
  const samples = kind === 'skip' ? buffers.skipSamples : buffers.failureSamples;
  if (samples.length < SAMPLE_LIMIT) samples.push(sample);
}

export function normalizeRateBackfillDiagnosticSamples(value: {
  skipSamples?: unknown;
  failureSamples?: unknown;
}): RateBackfillDiagnosticBuffers {
  return {
    skipSamples: Array.isArray(value.skipSamples)
      ? value.skipSamples.filter((sample): sample is string => typeof sample === 'string')
      : [],
    failureSamples: Array.isArray(value.failureSamples)
      ? value.failureSamples.filter((sample): sample is string => typeof sample === 'string')
      : [],
  };
}
