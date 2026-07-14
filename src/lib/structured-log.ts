import { AsyncLocalStorage } from 'node:async_hooks';

export type StructuredLogLevel = 'info' | 'warn' | 'error';
export type StructuredLogValue = string | number | boolean | null;
export type StructuredLogFields = Record<string, StructuredLogValue | undefined>;

const logContext = new AsyncLocalStorage<StructuredLogFields>();
const reportedErrors = new WeakSet<object>();

function definedFields(fields: StructuredLogFields | undefined): Record<string, StructuredLogValue> {
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, StructuredLogValue] => entry[1] !== undefined),
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carry request-scoped identifiers through awaited and detached async work.
 * Nested calls merge explicit money-path context such as orderId.
 */
export function runWithLogContext<T>(fields: StructuredLogFields, operation: () => T): T {
  return logContext.run(
    {
      ...definedFields(logContext.getStore()),
      ...definedFields(fields),
    },
    operation,
  );
}

/** Emit one machine-parseable JSON log line with stable canonical fields. */
export function logStructured(
  level: StructuredLogLevel,
  event: string,
  fields: StructuredLogFields = {},
): void {
  const payload = {
    ...definedFields(logContext.getStore()),
    ...definedFields(fields),
    timestamp: new Date().toISOString(),
    level,
    event,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

/**
 * Shared backend error sink. The same Error can cross service, route, and Hono
 * boundaries; identity deduplication keeps that failure to one structured line.
 */
export function reportError(
  event: string,
  error: unknown,
  fields: StructuredLogFields = {},
): void {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }

  logStructured('error', event, {
    ...fields,
    errorName: error instanceof Error ? error.name : typeof error,
    error: errorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
