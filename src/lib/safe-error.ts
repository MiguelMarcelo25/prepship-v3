import type { NodeStyleResponse } from './node-handler.js';
import { errorMessage, reportError } from './structured-log.js';

export { errorMessage } from './structured-log.js';

export const INTERNAL_SERVER_ERROR = 'Internal server error';

export function logServerError(scope: string, err: unknown): void {
  reportError(scope, err);
}

export function sendInternalServerError(
  res: NodeStyleResponse,
  scope: string,
  err: unknown,
  extra: Record<string, unknown> = {},
): void {
  logServerError(scope, err);
  res.status(500).json({ ok: false, error: INTERNAL_SERVER_ERROR, ...extra });
}
