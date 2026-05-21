import { timed, type TimingFields } from '../http/timing';

export function timedDb<T>(
  name: string,
  fn: () => Promise<T>,
  fields?: TimingFields,
): Promise<T> {
  return timed(name, fn, {
    logPrefix: '[db:timing]',
    thresholdMs: Number.parseInt(process.env.DB_TIMING_LOG_MS ?? '250', 10) || 250,
    fields,
  });
}
