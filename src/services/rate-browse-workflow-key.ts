import { createHash } from 'node:crypto';

function stableWorkflowValue(value: unknown): unknown {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableWorkflowValue);
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const child = input[key];
      if (child !== undefined) output[key] = stableWorkflowValue(child);
    }
    return output;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function buildRateBrowseWorkflowRequestKey(body: Record<string, unknown>): string {
  const payload = stableWorkflowValue(body);
  return `rate-browse-workflow:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 32)}`;
}
