import { logStructured, reportError } from '../lib/structured-log';

export type ApiProcessServer = {
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

type ApiProcessFailureKind = 'unhandled_rejection' | 'uncaught_exception';

type ApiProcessLifecycleOptions = {
  server: ApiProcessServer;
  shutdownTimeoutMs: number;
  uncaughtFailureLimit: number;
  exit?: (code: number) => void;
};

type ApiProcessLifecycle = {
  shutdown: (reason: string, exitCode?: number) => void;
  recordUncaughtFailure: (kind: ApiProcessFailureKind, error: unknown) => void;
};

/**
 * Canonical API process-lifecycle owner. Signals stop HTTP admission and drain
 * active requests; repeated failures escaping normal boundaries ask the process
 * supervisor for a clean restart through the same bounded shutdown path.
 */
export function createApiProcessLifecycle(
  options: ApiProcessLifecycleOptions,
): ApiProcessLifecycle {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let uncaughtFailureCount = 0;
  let shutdownStarted = false;
  let shutdownFinished = false;
  let shutdownReason = 'unknown';
  let desiredExitCode = 0;
  let forceTimer: NodeJS.Timeout | null = null;

  const finishShutdown = (forced: boolean): void => {
    if (shutdownFinished) return;
    shutdownFinished = true;
    if (forceTimer) {
      clearTimeout(forceTimer);
      forceTimer = null;
    }
    logStructured(desiredExitCode === 0 ? 'info' : 'warn', 'api.process.shutdown_complete', {
      reason: shutdownReason,
      exitCode: desiredExitCode,
      forced,
    });
    exit(desiredExitCode);
  };

  const forceClose = (error: unknown): void => {
    desiredExitCode = 1;
    reportError('api.process.shutdown_forced', error, {
      reason: shutdownReason,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
    });
    try {
      options.server.closeAllConnections?.();
    } catch (closeError) {
      reportError('api.process.force_close_failed', closeError, { reason: shutdownReason });
    }
    finishShutdown(true);
  };

  const shutdown = (reason: string, exitCode = 0): void => {
    desiredExitCode = Math.max(desiredExitCode, exitCode);
    if (shutdownStarted) return;
    shutdownStarted = true;
    shutdownReason = reason;

    logStructured('info', 'api.process.shutdown_started', {
      reason,
      exitCode: desiredExitCode,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
    });

    forceTimer = setTimeout(() => {
      forceClose(new Error(`API did not drain within ${options.shutdownTimeoutMs}ms`));
    }, options.shutdownTimeoutMs);

    try {
      options.server.close((error) => {
        if (error) {
          forceClose(error);
          return;
        }
        finishShutdown(false);
      });
      options.server.closeIdleConnections?.();
    } catch (error) {
      forceClose(error);
    }
  };

  const recordUncaughtFailure = (kind: ApiProcessFailureKind, error: unknown): void => {
    uncaughtFailureCount += 1;
    reportError(`process.${kind}`, error, {
      uncaughtFailureCount,
      uncaughtFailureLimit: options.uncaughtFailureLimit,
    });
    if (uncaughtFailureCount === options.uncaughtFailureLimit) {
      logStructured('error', 'api.process.uncaught_failure_limit_reached', {
        kind,
        uncaughtFailureCount,
        uncaughtFailureLimit: options.uncaughtFailureLimit,
      });
      shutdown(`uncaught_failure_limit:${kind}`, 1);
    }
  };

  return {
    shutdown,
    recordUncaughtFailure,
  };
}
