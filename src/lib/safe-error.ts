export const INTERNAL_SERVER_ERROR = 'Internal server error';

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function logServerError(scope: string, err: unknown): void {
  console.error(`[${scope}]`, errorMessage(err));
}

export function sendInternalServerError(
  res: any,
  scope: string,
  err: unknown,
  extra: Record<string, unknown> = {},
): void {
  logServerError(scope, err);
  res.status(500).json({ ok: false, error: INTERNAL_SERVER_ERROR, ...extra });
}
